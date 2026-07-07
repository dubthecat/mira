// Bot driver: pure pursuit on the centerline (with a wandering racing-line
// offset), curvature-limited target speed, and per-episode "personality"
// sampled from the seed. The bot outputs *discrete keys* — the same 6-key
// action set a human uses — so recorded action->frame dynamics are exactly
// what the world model must learn. Deliberate noise (random action bursts,
// sloppy steering thresholds, varied aggression) is injected for data
// diversity: a world model trained only on clean racing lines never learns
// what happens when you turn into a wall.

import { wrapAngle, clamp } from './rng.js';

export class BotDriver {
  constructor(track, seedRng) {
    this.track = track;
    this.rng = seedRng.fork('bot');
    const r = () => this.rng.next();

    this.p = {
      lookMin: 6 + 5 * r(),
      lookK: 0.3 + 0.18 * r(), // lookahead = lookMin + lookK * speed
      aLatMax: 13 + 11 * r(), // cornering aggression (m/s^2)
      vMax: 25 + 13 * r(),
      steerOn: 0.045 + 0.055 * r(), // rad of heading error to press A/D
      throttleMargin: 0.96,
      brakeMargin: 1.08 + 0.1 * r(),
      boostiness: 0.15 + 0.8 * r(), // per-frame prob of boosting on straights
      driftiness: r() * r(), // handbrake appetite in hard corners
      epsBurst: 0.002 + 0.006 * r(), // per-frame prob of a random-action burst
      offsetSigma: 1.4 + 1.6 * r(), // racing-line wander (m)
    };

    this.steerState = 0; // -1, 0, +1 with hysteresis
    this.offset = 0; // OU-process lateral offset from centerline
    this.burstFrames = 0;
    this.burstKeys = null;
    this.stuckFrames = 0;
    this.recoverFrames = 0;
    this.recoverSteer = 1;
  }

  // Called once per 20 Hz action frame. q = track projection of the car.
  decide(car, q) {
    const p = this.p;
    const t = this.track;
    const rng = this.rng;
    const u = car.u;

    // --- racing-line offset wanders as an OU process (deterministic)
    const dtF = 1 / 20;
    const tau = 3.0;
    this.offset =
      this.offset * Math.exp(-dtF / tau) +
      p.offsetSigma * Math.sqrt(1 - Math.exp((-2 * dtF) / tau)) * rng.gauss();
    const maxOff = Math.max(0, q.halfWidth - 2.6);
    const off = clamp(this.offset, -maxOff, maxOff);

    // --- stuck / wrong-way recovery
    const headingErr = wrapAngle(car.heading - q.theta);
    if (Math.abs(u) < 1.2) this.stuckFrames++;
    else this.stuckFrames = 0;
    if (this.recoverFrames > 0) {
      this.recoverFrames--;
      // reverse while steering so the nose swings back toward the track direction
      return keysFrom({
        S: true,
        A: this.recoverSteer > 0,
        D: this.recoverSteer < 0,
      });
    }
    if (this.stuckFrames > 28) {
      this.stuckFrames = 0;
      this.recoverFrames = 22;
      // steer so that reversing rotates us toward the track tangent
      this.recoverSteer = headingErr > 0 ? 1 : -1;
      return keysFrom({ S: true, A: this.recoverSteer > 0, D: this.recoverSteer < 0 });
    }

    // --- occasional random-action burst (exploration noise)
    if (this.burstFrames > 0) {
      this.burstFrames--;
      return { ...this.burstKeys };
    }
    if (rng.next() < p.epsBurst && Math.abs(u) > 4) {
      this.burstFrames = 5 + Math.floor(rng.next() * 16);
      this.burstKeys = keysFrom({
        W: rng.bool(0.6),
        S: rng.bool(0.2),
        A: rng.bool(0.35),
        D: rng.bool(0.35),
        Space: rng.bool(0.25),
        LShiftKey: rng.bool(0.2),
      });
      this.burstFrames--;
      return { ...this.burstKeys };
    }

    // --- pure pursuit toward a lookahead point on the (offset) centerline
    const lookahead = clamp(p.lookMin + p.lookK * Math.max(0, u), p.lookMin, 36);
    const tp = t.sampleAt(q.s + lookahead);
    const tx = tp.x - Math.sin(tp.theta) * off;
    const ty = tp.y + Math.cos(tp.theta) * off;
    const alpha = wrapAngle(Math.atan2(ty - car.y, tx - car.x) - car.heading);

    // hysteresis: engage steering above steerOn, release below half of it
    if (this.steerState === 0) {
      if (alpha > p.steerOn) this.steerState = 1;
      else if (alpha < -p.steerOn) this.steerState = -1;
    } else if (this.steerState === 1 && alpha < p.steerOn * 0.4) {
      this.steerState = alpha < -p.steerOn ? -1 : 0;
    } else if (this.steerState === -1 && alpha > -p.steerOn * 0.4) {
      this.steerState = alpha > p.steerOn ? 1 : 0;
    }

    // --- curvature-limited target speed over a braking horizon
    const horizon = 10 + (u * u) / 30; // ~ braking distance at ~15 m/s^2
    let kMax = 1e-4;
    const stepS = 3;
    for (let d = 4; d <= horizon; d += stepS) {
      const sm = t.sampleAt(q.s + d);
      // weight distant curvature less: only brake early for near corners
      const wgt = 1 / (1 + (d / horizon) * 0.6);
      kMax = Math.max(kMax, Math.abs(sm.kappa) * wgt);
    }
    let vTarget = Math.min(p.vMax, Math.sqrt(p.aLatMax / kMax));
    vTarget *= 1 / (1 + 1.6 * alpha * alpha); // slow down when pointing wrong

    const W = u < vTarget * p.throttleMargin;
    const S = u > vTarget * p.brakeMargin;

    // --- handbrake into genuinely hard corners, personality-gated
    const Space =
      Math.abs(alpha) > 0.34 && u > 17 && rng.next() < p.driftiness * 0.5;

    // --- boost on straights when fast and pointing right
    const straight = kMax < 0.006 && Math.abs(alpha) < 0.1;
    const LShiftKey =
      straight && car.boost > 30 && u > 0.55 * p.vMax && rng.next() < p.boostiness;

    return keysFrom({ W, S, A: this.steerState > 0, D: this.steerState < 0, Space, LShiftKey });
  }
}

function keysFrom(partial) {
  return {
    W: !!partial.W,
    S: !!partial.S,
    A: !!partial.A,
    D: !!partial.D,
    Space: !!partial.Space,
    LShiftKey: !!partial.LShiftKey,
  };
}
