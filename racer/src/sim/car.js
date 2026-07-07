// Arcade car physics on a fixed 60 Hz substep, driven purely by the discrete
// 6-key action set — the exact multi-hot vector the world model trains on.
//
// Model: kinematic bicycle for yaw + saturated lateral tire grip for slip.
// Velocity is decomposed each substep into forward (u) / lateral (w) components
// in the car frame; grip applies an acceleration -sign(w)*min(lambda*|w|, aGripMax)
// so gentle cornering tracks cleanly while hard cornering (or handbrake, which
// lowers both grip constants) breaks into a drift with the tail stepping out.

import { wrapAngle, clamp } from './rng.js';

// Multi-hot action order — must match configs/actions/racing.yaml exactly.
export const ACTION_KEYS = ['W', 'S', 'A', 'D', 'Space', 'LShiftKey'];

export const CAR = {
  wheelbase: 2.6,
  radius: 1.15, // collision radius against walls
  uMax: 38, // m/s, top speed without boost
  uMaxBoost: 46,
  reverseMax: 12,
  aEngine: 13.5,
  aBrake: 21,
  aReverse: 7.5,
  aBoost: 11,
  coastA: 0.8, // constant + linear coast/engine-brake decel
  coastB: 0.09,
  steerMax: 0.55, // rad, at standstill
  steerSpeedRef: 28, // steering authority falls off ~ 1/(1+u/ref)
  steerRate: 6.0, // rad/s toward target
  steerReturn: 8.5, // rad/s back to centre
  gripLambda: 9.0, // 1/s lateral velocity decay when gripping
  gripMaxA: 26, // m/s^2 tire saturation
  driftLambda: 3.2, // handbrake values
  driftMaxA: 11,
  boostDrain: 33, // %/s
  boostRegen: 5, // %/s passive
  boostPadGain: 30,
  wallRestitution: 0.25,
  wallTangentKeep: 0.88,
};

// Per-spec physics parameters: multipliers over the base tuning, so handling
// presets survive future re-tuning of the defaults.
export function carParamsFor(spec) {
  const v = spec.vehicle;
  return {
    ...CAR,
    uMax: CAR.uMax * v.topSpeedScale,
    uMaxBoost: CAR.uMaxBoost * v.topSpeedScale,
    aEngine: CAR.aEngine * v.accelScale,
    aBoost: CAR.aBoost * v.boostScale,
    gripLambda: CAR.gripLambda * v.gripScale,
    gripMaxA: CAR.gripMaxA * v.gripScale,
    driftLambda: CAR.driftLambda * v.gripScale,
    driftMaxA: CAR.driftMaxA * v.gripScale,
  };
}

export class Car {
  constructor(track, startS = 6, params = CAR) {
    const p = track.sampleAt(startS);
    this.track = track;
    this.p = params;
    this.x = p.x;
    this.y = p.y;
    this.heading = p.theta;
    this.vx = 0;
    this.vy = 0;
    this.steer = 0; // current steering angle (rad, +left)
    this.boost = 60; // meter 0..100
    this.boosting = false;
    this.drifting = false;
    this.hintIdx = p ? track.nearest(p.x, p.y).idx : 0;
    this.wallImpact = 0; // impact speed of the most recent substep's wall hit
    this.slip = 0; // lateral speed (for visuals/telemetry)
    this.u = 0; // forward speed (for telemetry)
  }

  // keys: {W,S,A,D,Space,LShiftKey,F} booleans, held for this substep
  // (F is consumed by the world's weapon logic, not by the car)
  step(keys, dt) {
    const c = this.p;
    this.wallImpact = 0;

    // --- steering integrates toward the commanded side
    const steerTarget = (keys.A ? 1 : 0) - (keys.D ? 1 : 0);
    if (steerTarget !== 0) {
      this.steer += clamp(steerTarget * c.steerMax - this.steer, -c.steerRate * dt, c.steerRate * dt);
    } else {
      const d = clamp(-this.steer, -c.steerReturn * dt, c.steerReturn * dt);
      this.steer += d;
      if (Math.abs(this.steer) < 1e-4) this.steer = 0;
    }

    // --- decompose velocity into the car frame
    let cos = Math.cos(this.heading);
    let sin = Math.sin(this.heading);
    let u = this.vx * cos + this.vy * sin; // forward
    let w = -this.vx * sin + this.vy * cos; // lateral (+left)

    // --- longitudinal
    this.boosting = false;
    let uMaxCur = c.uMax;
    if (keys.LShiftKey && this.boost > 0.5 && u > -0.5) {
      this.boosting = true;
      uMaxCur = c.uMaxBoost;
      this.boost = Math.max(0, this.boost - c.boostDrain * dt);
    } else {
      this.boost = Math.min(100, this.boost + c.boostRegen * dt);
    }

    let aLong = 0;
    if (keys.W) {
      aLong += Math.max(0, c.aEngine * (1 - u / uMaxCur));
    }
    if (this.boosting) {
      aLong += u < uMaxCur ? c.aBoost : 0;
    }
    if (keys.S) {
      if (u > 0.5) aLong -= c.aBrake;
      else aLong -= Math.max(0, c.aReverse * (1 - -u / c.reverseMax));
    }
    if (!keys.W && !keys.S && !this.boosting && u !== 0) {
      // coast/engine-brake decel, capped so it stops exactly at zero
      const coast = c.coastA + c.coastB * Math.abs(u);
      aLong -= Math.sign(u) * Math.min(coast, Math.abs(u) / dt);
    } else if (keys.W && !this.boosting && u > uMaxCur) {
      // above the cap (e.g. boost just ran out) the engine gives zero force,
      // so drag must bleed speed back down to uMaxCur instead of holding it
      const coast = c.coastA + c.coastB * u;
      aLong -= Math.min(coast, (u - uMaxCur) / dt);
    }
    const handbrakeDecel = keys.Space && Math.abs(u) > 0.5 ? 4.5 * Math.sign(u) : 0;
    u += (aLong - handbrakeDecel) * dt;

    // dead-stop snap to avoid micro-jitter at rest
    if (!keys.W && !keys.S && Math.abs(u) < 0.15) u = 0;

    // --- yaw from bicycle geometry, steering authority fades with speed
    const steerEff =
      (this.steer / (1 + Math.abs(u) / c.steerSpeedRef)) * (keys.Space ? 1.2 : 1.0);
    const omega = (u / c.wheelbase) * Math.tan(steerEff);
    this.heading = wrapAngle(this.heading + omega * dt);

    // --- re-decompose in the rotated frame (this is what creates slip),
    // then saturated grip pulls lateral velocity back toward zero
    cos = Math.cos(this.heading);
    sin = Math.sin(this.heading);
    {
      const vx = u * Math.cos(this.heading - omega * dt) - w * Math.sin(this.heading - omega * dt);
      const vy = u * Math.sin(this.heading - omega * dt) + w * Math.cos(this.heading - omega * dt);
      u = vx * cos + vy * sin;
      w = -vx * sin + vy * cos;
    }
    const lowSpeed = Math.abs(u) < 5 ? 2.0 : 1.0;
    const lambda = (keys.Space ? c.driftLambda : c.gripLambda) * lowSpeed;
    const gripMax = keys.Space ? c.driftMaxA : c.gripMaxA;
    const aGrip = -Math.sign(w) * Math.min(lambda * Math.abs(w), gripMax);
    const wNew = w + aGrip * dt;
    w = Math.sign(wNew) === Math.sign(w) ? wNew : 0;
    this.drifting = Math.abs(w) > 3.5;

    // --- recompose, integrate position
    this.vx = u * cos - w * sin;
    this.vy = u * sin + w * cos;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.u = u;
    this.slip = w;

    // --- walls: track edge is a hard barrier with restitution + scrape
    const q = this.track.nearest(this.x, this.y, this.hintIdx);
    this.hintIdx = q.idx;
    const limit = q.halfWidth - c.radius;
    if (Math.abs(q.lateral) > limit) {
      // inward wall normal (points back onto the track)
      const side = Math.sign(q.lateral);
      const nx = -Math.sin(q.theta) * -side;
      const ny = Math.cos(q.theta) * -side;
      // push back onto the boundary
      const overshoot = Math.abs(q.lateral) - limit;
      this.x += nx * overshoot;
      this.y += ny * overshoot;
      // reflect the normal velocity component, damp the tangential one
      const vn = this.vx * nx + this.vy * ny;
      if (vn < 0) {
        this.vx -= nx * vn * (1 + c.wallRestitution);
        this.vy -= ny * vn * (1 + c.wallRestitution);
        this.vx *= c.wallTangentKeep;
        this.vy *= c.wallTangentKeep;
        this.wallImpact = -vn;
      }
    }
    return q; // caller (world) reuses the projection for lap/pad logic
  }
}
