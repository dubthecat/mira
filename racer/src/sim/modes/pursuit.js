// Pursuit mode: an open-field escape chase. The avatar flees
// spec.pursuit.hunters hunter cars that ram on contact; the field's POI
// structures are cover AND traps — a hunter that piles into one at speed
// wrecks for 8 s and respawns on the rim, so the player bot survives by
// baiting as much as by outrunning. Survival near the pack scores points
// (+10 per second with a hunter inside 60 m).
//
// DAMAGE MODEL — read before touching. Monsters hurt the car through
// EntitySystem.step's damageToCar return, which world.js turns into
// health/invuln/respawn bookkeeping. Hunters are MODE bodies, not entities,
// so their ram damage cannot flow through that path. Instead postStep applies
// a mirror of the exact world.js block: the same world.invulnSub<=0 &&
// world.respawnSub<=0 gate, the same invulnSub reset
// (contactInvulnFrames * SUBSTEPS), the same CarDamaged/CarDestroyed event
// order and payloads, and the same respawnSub arm on death. Because both
// paths share the single invulnSub window, at most one damage source lands
// per invuln window and event-ledger accounting (invariants_check-style)
// holds identically for pursuit episodes.
//
// Weapons: player projectiles only collide with monsters inside EntitySystem,
// so the mode tests live projectiles against hunter bodies in postStep and
// marks hits dead (mutating p.alive is the sanctioned pattern). Three hits
// wreck a hunter like a POI crash does.
//
// Determinism: all randomness comes from world.rng (buildOpenField) or forks
// made in build(), in a call order that is a pure function of (seed, spec).

import { buildOpenField, bounce } from '../spaces.js';
import { Car, carParamsFor } from '../car.js';
import { wrapAngle, clamp } from '../rng.js';

const SUBSTEPS = 3; // world.js steps the mode 3x per 20 Hz action frame
const RAM_DAMAGE = 25; // health per hunter ram (invuln-gated, see header)
const RAM_RADIUS = 3.0; // hunter-player centre distance that counts as a ram
const WRECK_IMPACT = 20; // m/s of POI impact speed that wrecks a hunter
const WRECK_FRAMES = 160; // 8 s of wreck downtime before a rim respawn
const HUNTER_HITS = 3; // player projectile hits that wreck a hunter
const HEAT_RADIUS = 60; // survival scoring needs a live hunter this close
const HEAT_FAR = 999; // world.pursuit.heat when no live hunter exists

const EMPTY_KEYS = { W: false, S: false, A: false, D: false, Space: false, LShiftKey: false, F: false };

// Car.step queries this.track for wall collisions; open terrain has none.
// halfWidth=Infinity keeps the wall branch dead — the cliff ring and POI
// structures are enforced through spaces.bounce in stepAvatar/postStep.
// scenery values equal the trackless defaults in scene.js (biome-pure look).
function stubTrack(x, y, heading) {
  const q = { idx: 0, s: 0, lateral: 0, theta: heading, halfWidth: Infinity, kappa: 0, cx: x, cy: y };
  return {
    length: 0,
    scenery: { palette: { grassHue: 0.31, grassLight: 0.37, skyHue: 0.58, asphaltLight: 0.2 } },
    sampleAt: () => ({ x, y, theta: heading, kappa: 0, halfWidth: Infinity }),
    nearest: () => q,
  };
}

function keysFrom(partial) {
  return {
    W: !!partial.W,
    S: !!partial.S,
    A: !!partial.A,
    D: !!partial.D,
    Space: !!partial.Space,
    LShiftKey: !!partial.LShiftKey,
    F: !!partial.F,
  };
}

export class PursuitMode {
  constructor(spec) {
    this.spec = spec;
  }

  build(world) {
    const cfg = this.spec.pursuit;
    const extent = 200 * cfg.worldScale;
    const field = buildOpenField(world.rng, { extent, pois: 10 });
    world.space = field;
    this._field = field;

    const params = carParamsFor(this.spec);
    const stub = stubTrack(0, 0, 0); // player spawns at field centre facing +x
    world.track = stub; // recorder/HUD read track.length; minimap guards on .xs
    world.car = new Car(stub, 0, params);
    world.progress = 0; // odometer (metres travelled), for meta/gates parity

    // --- hunters: same chassis, top speed ~0.92*heat relative to the player
    // (escapable at heat 1.0, genuinely scary above it), spawned on the rim.
    // Rubber-banding happens through boost usage, not params (see decide).
    const heat = cfg.heat;
    const spawnRng = world.rng.fork('pursuit-spawn');
    const brainRng = world.rng.fork('pursuit-brains');
    this._rimRng = world.rng.fork('pursuit-rim'); // wreck-respawn positions
    this.hunters = [];
    for (let i = 0; i < cfg.hunters; i++) {
      const hp = {
        ...params,
        uMax: params.uMax * 0.92 * heat,
        uMaxBoost: params.uMaxBoost * 0.92 * heat,
        aEngine: params.aEngine * (0.85 + 0.2 * heat),
      };
      const a = ((i + 0.5) / cfg.hunters) * Math.PI * 2 + spawnRng.range(-0.3, 0.3);
      const r = extent - 14;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      const hcar = new Car(stubTrack(px, py, wrapAngle(a + Math.PI)), 0, hp);
      // staggered aggression: the pack mixes a cautious shadow with reckless
      // rammers — reckless ones fixate from farther out and probe less,
      // which is exactly what drives them into baited POI wrecks
      const aggBase = cfg.hunters > 1 ? 0.55 + 0.45 * (i / (cfg.hunters - 1)) : 0.8;
      const rng = brainRng.fork(`h${i}`);
      this.hunters.push({
        id: i,
        car: hcar,
        rng,
        p: {
          aggression: clamp(aggBase + rng.range(-0.08, 0.08), 0.45, 1),
          steerOn: 0.05 + 0.05 * rng.next(),
          leadScale: 0.55 + 0.55 * rng.next(),
          boostiness: 0.35 + 0.55 * rng.next(),
          fixation: 12 + 16 * aggBase, // inside this range: no POI avoidance
        },
        keys: null,
        wreckedUntil: -1, // -1 live; else the frame the wreck clears
        hits: 0, // player projectile hits since last (re)spawn
        stuckFrames: 0,
        recoverFrames: 0,
        recoverSteer: 1,
        steerState: 0,
        avoidSide: 0,
        avoidHold: 0,
      });
    }

    // battery/HUD-facing surface: live hunter count, cumulative wrecks and
    // the distance to the nearest live hunter ("heat"), refreshed per frame.
    // world.matchScore / world.objective / world.wave stay intentionally
    // unset — pursuit's HUD is speed/boost/health/score only.
    world.pursuit = { hunters: cfg.hunters, alive: cfg.hunters, wrecked: 0, heat: HEAT_FAR };

    this._decideFrame = -1;
    this._scoreFrame = -1;
    this._heatFrames = 0; // cumulative frames with a hunter inside HEAT_RADIUS

    // --- evader bot personality + state (fork made in build: deterministic)
    this._rng = world.rng.fork('pursuit-bot');
    const r = () => this._rng.next();
    this._p = {
      steerOn: 0.05 + 0.05 * r(),
      boostiness: 0.35 + 0.5 * r(),
      epsBurst: 0.002 + 0.005 * r(), // random-action burst probability
      trigger: 0.4 + 0.5 * r(), // per-frame fire prob on a lined-up hunter
      baitiness: 0.55 + 0.45 * r(), // eagerness to skim POIs for wrecks
    };
    this._steerState = 0;
    this._burstFrames = 0;
    this._burstKeys = null;
    this._stuckFrames = 0;
    this._recoverFrames = 0;
    this._recoverSteer = 1;
    this._avoidSide = 0;
    this._avoidHold = 0;
    this._baitIdx = -1;
    this._baitSide = 1;
    this._baitHold = 0;
    this._baitCd = 0;
    this._seek = null; // pickup-seeking state: null | 'health' | 'ammo'
    this._roamIdx = 0; // lull waypoint when every hunter is wrecked/far
    world.botPolicy = 'pursuit-evader';
  }

  // --- evader bot ------------------------------------------------------------
  decide(world) {
    const car = world.car;
    const p = this._p;
    const rng = this._rng;
    const field = this._field;
    const extent = field.extent;
    const armed = !!world.spec.weapon.enabled;
    const u = car.u;

    // dead: hold nothing (avatar frozen; don't wind up stuck counters)
    if (world.respawnSub > 0) {
      this._stuckFrames = 0;
      return keysFrom({});
    }

    // threat picture: inverse-square repulsion over the live pack (fleeing
    // only the nearest hunter runs straight into its flanking packmate)
    let nd = Infinity;
    let rx = 0;
    let ry = 0;
    let nLive = 0;
    for (const h of this.hunters) {
      if (h.wreckedUntil >= 0) continue;
      nLive++;
      const d = Math.hypot(h.car.x - car.x, h.car.y - car.y) || 1e-3;
      if (d < nd) nd = d;
      rx += (car.x - h.car.x) / (d * d * d);
      ry += (car.y - h.car.y) / (d * d * d);
    }

    // --- stuck recovery: reverse while swinging the nose free
    if (this._recoverFrames > 0) {
      this._recoverFrames--;
      return keysFrom({ S: true, A: this._recoverSteer > 0, D: this._recoverSteer < 0 });
    }
    if (Math.abs(u) < 1.2) this._stuckFrames++;
    else this._stuckFrames = 0;
    if (this._stuckFrames > 24) {
      this._stuckFrames = 0;
      this._recoverFrames = 16;
      const away = nLive > 0 ? Math.atan2(ry, rx) : Math.atan2(-car.y, -car.x);
      const err = wrapAngle(away - car.heading);
      this._recoverSteer = err < 0 ? 1 : -1; // reversing flips yaw response
      return keysFrom({ S: true, A: this._recoverSteer > 0, D: this._recoverSteer < 0 });
    }

    // --- occasional random-action burst (exploration noise / data diversity)
    if (this._burstFrames > 0) {
      this._burstFrames--;
      return { ...this._burstKeys };
    }
    if (rng.next() < p.epsBurst && Math.abs(u) > 4) {
      this._burstFrames = 4 + Math.floor(rng.next() * 12);
      this._burstKeys = keysFrom({
        W: rng.bool(0.65),
        S: rng.bool(0.15),
        A: rng.bool(0.35),
        D: rng.bool(0.35),
        Space: rng.bool(0.2),
        LShiftKey: rng.bool(0.25),
        F: armed ? rng.bool(0.3) : false,
      });
      this._burstFrames--;
      return { ...this._burstKeys };
    }

    // --- desired heading
    let desired;
    const rr = Math.hypot(car.x, car.y);
    if (nLive === 0 || nd > 110) {
      // lull (pack wrecked or distant): cruise POI stand-off waypoints so the
      // dataset keeps optical flow and the chase re-arms on respawns
      const poi = field.pois[this._roamIdx % field.pois.length];
      const dp = Math.hypot(poi.x, poi.y) || 1;
      const gx = poi.x - (poi.x / dp) * (poi.size * 0.6 + 8);
      const gy = poi.y - (poi.y / dp) * (poi.size * 0.6 + 8);
      if (Math.hypot(gx - car.x, gy - car.y) < 14) {
        this._roamIdx = (this._roamIdx + 1) % field.pois.length;
      }
      desired = Math.atan2(gy - car.y, gx - car.x);
      this._baitHold = 0;
    } else {
      const away = Math.atan2(ry, rx);
      // the flee direction walls out at the rim: carve onto the ring tangent
      // that keeps running from the pack, biased slightly inward
      const wallness = clamp((rr / extent - 0.62) / 0.3, 0, 1);
      if (wallness > 0) {
        const ang = Math.atan2(car.y, car.x);
        const t1 = ang + Math.PI / 2;
        const t2 = ang - Math.PI / 2;
        const tan = Math.abs(wrapAngle(t1 - away)) <= Math.abs(wrapAngle(t2 - away)) ? t1 : t2;
        const inward = wrapAngle(tan + wrapAngle(Math.atan2(-car.y, -car.x) - tan) * 0.25);
        desired = wrapAngle(away + wrapAngle(inward - away) * wallness);
      } else {
        desired = away;
      }

      // bait weave: when pressed, bend the escape line to skim a POI's edge —
      // fixated hunters follow the skim straight into the rock
      if (this._baitCd > 0) this._baitCd--;
      if (this._baitHold > 0) this._baitHold--;
      if (nd < 34 && this._baitHold <= 0 && this._baitCd <= 0) {
        let best = -1;
        let bd = Infinity;
        for (let i = 0; i < field.pois.length; i++) {
          const poi = field.pois[i];
          const dxp = poi.x - car.x;
          const dyp = poi.y - car.y;
          const d = Math.hypot(dxp, dyp);
          if (d < 14 || d > 65) continue;
          if (Math.abs(wrapAngle(Math.atan2(dyp, dxp) - desired)) > 0.75) continue;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        if (best >= 0 && rng.next() < p.baitiness) {
          this._baitIdx = best;
          this._baitHold = 70; // ~3.5 s commitment
          const poi = field.pois[best];
          const d = Math.hypot(poi.x - car.x, poi.y - car.y) || 1;
          const nx = (poi.x - car.x) / d;
          const ny = (poi.y - car.y) / d;
          // skim the edge nearer the current escape line
          this._baitSide = nx * Math.sin(desired) - ny * Math.cos(desired) >= 0 ? 1 : -1;
        } else {
          this._baitCd = 20; // don't rescan every frame
        }
      }
      if (this._baitHold > 0) {
        const poi = field.pois[this._baitIdx];
        const d = Math.hypot(poi.x - car.x, poi.y - car.y) || 1;
        if (d < poi.size * 0.6 + 5) this._baitHold = Math.min(this._baitHold, 3); // passing: release
        const nx = (poi.x - car.x) / d;
        const ny = (poi.y - car.y) / d;
        const off = poi.size * 0.6 + 2.6;
        const sx = poi.x - ny * this._baitSide * off;
        const sy = poi.y + nx * this._baitSide * off;
        desired = Math.atan2(sy - car.y, sx - car.x);
      }
    }

    // --- pickups: top up when hurting/dry, but never straight into the pack
    if (this._seek === 'health' && world.health >= 70) this._seek = null;
    if (this._seek === 'ammo' && (!armed || world.ammo >= 8)) this._seek = null;
    if (!this._seek) {
      if (world.health < 45) this._seek = 'health';
      else if (armed && world.ammo < 3) this._seek = 'ammo';
    }
    if (this._seek) {
      let bestD2 = 90 * 90;
      let gx = null;
      let gy = null;
      for (const pk of world.entities.pickups) {
        if (pk.kind !== this._seek || pk.cooldown > 0) continue;
        const dx = pk.x - car.x;
        const dy = pk.y - car.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          gx = pk.x;
          gy = pk.y;
        }
      }
      if (gx !== null) {
        const toPk = Math.atan2(gy - car.y, gx - car.x);
        if (nLive === 0 || Math.abs(wrapAngle(toPk - desired)) < 1.2) desired = toPk;
      } else {
        this._seek = null;
      }
    }

    // --- self-preservation probe: never drive the escape line into a rock
    // (committed skirt side, same shape as the adventure bot)
    let alpha = wrapAngle(desired - car.heading);
    if (this._avoidHold > 0) this._avoidHold--;
    let blocked = false;
    {
      const probeLen = 8 + 0.3 * Math.max(u, 0);
      const res = field.constrain(
        car.x + Math.cos(car.heading) * probeLen,
        car.y + Math.sin(car.heading) * probeLen,
        car.p.radius + 0.3,
      );
      if (res.hit) {
        blocked = true;
        if (this._avoidSide === 0 || this._avoidHold === 0) {
          this._avoidSide = -res.ny * Math.cos(desired) + res.nx * Math.sin(desired) >= 0 ? 1 : -1;
          this._avoidHold = 26;
        }
        const tx = -res.ny * this._avoidSide + res.nx * 0.5;
        const ty = res.nx * this._avoidSide + res.ny * 0.5;
        alpha = wrapAngle(Math.atan2(ty, tx) - car.heading);
      }
    }
    if (!blocked && this._avoidHold === 0) this._avoidSide = 0;

    this._applySteerHysteresis(alpha);

    // --- throttle: keep speed high, brake only to rotate a hard reversal
    const W = Math.abs(alpha) < 1.4 || u < 10;
    const S = Math.abs(alpha) > 2.0 && u > 16;

    // --- boost: burn it when the heat is on the bumper and we're lined up;
    // occasional personality-gated bursts on longer escapes
    const LShiftKey =
      car.boost > 22 &&
      Math.abs(alpha) < 0.35 &&
      u > 8 &&
      (nd < 34 || (nd < 90 && rng.next() < p.boostiness * 0.06));

    // --- drive-by fire: squeeze shots when a live hunter crosses the barrel
    // (the weapon fires forward only, so shots happen while repositioning)
    let F = false;
    if (armed && world.ammo > 0) {
      for (const h of this.hunters) {
        if (h.wreckedUntil >= 0) continue;
        const dx = h.car.x - car.x;
        const dy = h.car.y - car.y;
        if (dx * dx + dy * dy > 50 * 50) continue;
        if (Math.abs(wrapAngle(Math.atan2(dy, dx) - car.heading)) < 0.18) {
          F = rng.next() < p.trigger;
          break;
        }
      }
    }

    return keysFrom({ W, S, A: this._steerState > 0, D: this._steerState < 0, LShiftKey, F });
  }

  // same hysteresis shape as the circuit bot: engage above steerOn, release
  // below 40% of it — avoids A/D chatter on straight runs
  _applySteerHysteresis(alpha) {
    const on = this._p.steerOn;
    if (this._steerState === 0) {
      if (alpha > on) this._steerState = 1;
      else if (alpha < -on) this._steerState = -1;
    } else if (this._steerState === 1 && alpha < on * 0.4) {
      this._steerState = alpha < -on ? -1 : 0;
    } else if (this._steerState === -1 && alpha > -on * 0.4) {
      this._steerState = alpha > on ? 1 : 0;
    }
  }

  // --- hunter AI ---------------------------------------------------------------
  _hunterDecide(world, h) {
    const hc = h.car;
    const car = world.car;
    const p = h.p;
    const field = this._field;
    const dx = car.x - hc.x;
    const dy = car.y - hc.y;
    const dist = Math.hypot(dx, dy);

    // stuck recovery (pinned on a rock or the rim): reverse-swing free
    if (h.recoverFrames > 0) {
      h.recoverFrames--;
      return keysFrom({ S: true, A: h.recoverSteer > 0, D: h.recoverSteer < 0 });
    }
    if (Math.abs(hc.u) < 1.1) h.stuckFrames++;
    else h.stuckFrames = 0;
    if (h.stuckFrames > 24) {
      h.stuckFrames = 0;
      h.recoverFrames = 16;
      const err = wrapAngle(Math.atan2(dy, dx) - hc.heading);
      h.recoverSteer = err < 0 ? 1 : -1; // reversing flips yaw response
      return keysFrom({ S: true, A: h.recoverSteer > 0, D: h.recoverSteer < 0 });
    }

    // predictive intercept: lead the player by projected travel time
    const closing = Math.max(12, Math.hypot(hc.vx, hc.vy));
    const tLead = clamp(dist / closing, 0, 1.3) * p.leadScale;
    const tx = car.x + car.vx * tLead;
    const ty = car.y + car.vy * tLead;
    let alpha = wrapAngle(Math.atan2(ty - hc.y, tx - hc.x) - hc.heading);

    // POI avoidance probe — SKIPPED inside fixation range: a hunter locked
    // onto its prey follows the bait line straight into the rock. Cautious
    // personalities probe farther and fixate later than reckless ones.
    let blocked = false;
    if (h.avoidHold > 0) h.avoidHold--;
    if (dist > p.fixation) {
      const probeLen = (6 + 0.26 * Math.max(hc.u, 0)) * (1.35 - 0.55 * p.aggression);
      const res = field.constrain(
        hc.x + Math.cos(hc.heading) * probeLen,
        hc.y + Math.sin(hc.heading) * probeLen,
        hc.p.radius,
      );
      if (res.hit) {
        blocked = true;
        if (h.avoidSide === 0 || h.avoidHold === 0) {
          const gd = Math.hypot(tx - hc.x, ty - hc.y) || 1;
          h.avoidSide = (-res.ny * (tx - hc.x)) / gd + (res.nx * (ty - hc.y)) / gd >= 0 ? 1 : -1;
          h.avoidHold = 24;
        }
        const ax = -res.ny * h.avoidSide + res.nx * 0.55;
        const ay = res.nx * h.avoidSide + res.ny * 0.55;
        alpha = wrapAngle(Math.atan2(ay, ax) - hc.heading);
      }
    }
    if (!blocked && h.avoidHold === 0) h.avoidSide = 0;

    // steering hysteresis
    const on = p.steerOn;
    if (h.steerState === 0) {
      if (alpha > on) h.steerState = 1;
      else if (alpha < -on) h.steerState = -1;
    } else if (h.steerState === 1 && alpha < on * 0.4) {
      h.steerState = alpha < -on ? -1 : 0;
    } else if (h.steerState === -1 && alpha > -on * 0.4) {
      h.steerState = alpha > on ? 1 : 0;
    }

    const W = blocked ? hc.u < 16 : Math.abs(alpha) < 1.35 || hc.u < 10;
    const S = Math.abs(alpha) > 2.0 && hc.u > 14;
    // rubber-banding: the farther behind, the harder they burn boost to close
    // (bounded by heat through uMaxBoost); close in they run at base speed
    const LShiftKey =
      !blocked &&
      hc.boost > 25 &&
      Math.abs(alpha) < 0.3 &&
      dist > 38 + 45 * (1 - p.boostiness);

    return keysFrom({ W, S, A: h.steerState > 0, D: h.steerState < 0, LShiftKey });
  }

  stepAvatar(world, keys, dt) {
    const car = world.car;
    const q = car.step(keys, dt); // stub track: wall branch never fires
    const res = this._field.constrain(car.x, car.y, car.p.radius);
    const impact = bounce(car, res, car.p.wallRestitution, car.p.wallTangentKeep);
    if (impact > 0) car.wallImpact = Math.max(car.wallImpact, impact);
    return q;
  }

  postStep(world, keys, dt, frameEvents) {
    const car = world.car;
    const field = this._field;
    world.progress += Math.hypot(car.vx, car.vy) * dt; // odometer

    // hunter decisions at 20 Hz (once per action frame), physics per substep
    if (this._decideFrame !== world.frame) {
      this._decideFrame = world.frame;
      for (const h of this.hunters) {
        h.keys = h.wreckedUntil >= 0 ? null : this._hunterDecide(world, h);
      }
    }

    for (const h of this.hunters) {
      if (h.wreckedUntil >= 0) {
        // wrecked: inert on the field until the downtime clears, then a
        // fresh rim spawn (deterministic: wreck timing is (seed, spec)-pure)
        if (world.frame >= h.wreckedUntil) this._respawnHunter(h);
        continue;
      }
      h.car.step(h.keys || EMPTY_KEYS, dt);
      const res = field.constrain(h.car.x, h.car.y, h.car.p.radius);
      const impact = bounce(h.car, res, h.car.p.wallRestitution, h.car.p.wallTangentKeep);
      if (impact > WRECK_IMPACT && res.hit) {
        // constrain resolves either the rim or a POI; only POI piles wreck
        const onRim = Math.hypot(res.x, res.y) > field.extent - h.car.p.radius - 0.5;
        if (!onRim) {
          this._wreck(world, h, frameEvents);
          continue;
        }
      }
    }

    // car-vs-car separation (equal mass, mild restitution; wrecks skipped)
    for (let i = 0; i < this.hunters.length; i++) {
      const hi = this.hunters[i];
      if (hi.wreckedUntil >= 0) continue;
      this._bump(car, hi.car);
      for (let j = i + 1; j < this.hunters.length; j++) {
        const hj = this.hunters[j];
        if (hj.wreckedUntil >= 0) continue;
        this._bump(hi.car, hj.car);
      }
    }

    // --- rams: EXACT mirror of the world.js damage block (see file header).
    // postStep never runs during the death freeze, but the respawnSub guard
    // stays for parity with world.js's condition.
    if (world.invulnSub <= 0 && world.respawnSub <= 0) {
      for (const h of this.hunters) {
        if (h.wreckedUntil >= 0) continue;
        const d = Math.hypot(h.car.x - car.x, h.car.y - car.y);
        if (d < RAM_RADIUS) {
          world.health -= RAM_DAMAGE;
          world.invulnSub = world.spec.rules.contactInvulnFrames * SUBSTEPS;
          frameEvents.push({ name: 'CarDamaged', data: { health: Math.max(0, world.health) } });
          if (world.health <= 0) {
            world.health = 0;
            world.respawnSub = world.spec.rules.respawnFrames * SUBSTEPS;
            frameEvents.push({ name: 'CarDestroyed', data: {} });
          }
          break; // the invuln window admits one source per substep anyway
        }
      }
    }

    // --- player projectiles vs hunters (EntitySystem only collides shots
    // with monsters; the mode owns the hunter extension — see file header)
    if (world.spec.weapon.enabled) {
      for (const pr of world.entities.projectiles) {
        if (!pr.alive || pr.hostile) continue;
        for (const h of this.hunters) {
          if (h.wreckedUntil >= 0) continue;
          if (Math.hypot(h.car.x - pr.x, h.car.y - pr.y) < 2.0) {
            pr.alive = false;
            h.hits++;
            if (h.hits >= HUNTER_HITS) this._wreck(world, h, frameEvents);
            break;
          }
        }
      }
    }

    // --- surface refresh every substep (wrecks can land mid-frame, and the
    // recorder snapshots after the full frame) + per-frame survival scoring
    let nearest = HEAT_FAR;
    let alive = 0;
    for (const h of this.hunters) {
      if (h.wreckedUntil >= 0) continue;
      alive++;
      const d = Math.hypot(h.car.x - car.x, h.car.y - car.y);
      if (d < nearest) nearest = d;
    }
    world.pursuit.alive = alive;
    world.pursuit.heat = nearest;
    if (this._scoreFrame !== world.frame) {
      this._scoreFrame = world.frame;
      if (nearest < HEAT_RADIUS) {
        this._heatFrames++;
        if (this._heatFrames % 20 === 0) world.score += 10; // +10 per hot second
      }
    }
  }

  _wreck(world, h, frameEvents) {
    h.wreckedUntil = world.frame + WRECK_FRAMES;
    h.keys = null;
    h.car.vx = 0;
    h.car.vy = 0;
    h.car.u = 0;
    h.car.slip = 0;
    world.pursuit.wrecked++;
    frameEvents.push({ name: 'HunterWrecked', data: { id: h.id } });
  }

  _respawnHunter(h) {
    const a = this._rimRng.range(0, Math.PI * 2);
    const r = this._field.extent - 14;
    const c = h.car;
    c.x = Math.cos(a) * r;
    c.y = Math.sin(a) * r;
    c.heading = wrapAngle(a + Math.PI); // face the field centre
    c.vx = 0;
    c.vy = 0;
    c.u = 0;
    c.steer = 0;
    c.slip = 0;
    h.wreckedUntil = -1;
    h.hits = 0;
    h.keys = null;
    h.stuckFrames = 0;
    h.recoverFrames = 0;
    h.steerState = 0;
    h.avoidSide = 0;
    h.avoidHold = 0;
  }

  _bump(A, B) {
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const d = Math.hypot(dx, dy);
    const minD = 2.4;
    if (d >= minD || d < 1e-6) return;
    const nx = dx / d;
    const ny = dy / d;
    const push = (minD - d) / 2;
    A.x -= nx * push;
    A.y -= ny * push;
    B.x += nx * push;
    B.y += ny * push;
    const vn = (A.vx - B.vx) * nx + (A.vy - B.vy) * ny;
    if (vn > 0) {
      const k = vn * 0.65; // (1 + e) / 2 with e = 0.3
      A.vx -= nx * k;
      A.vy -= ny * k;
      B.vx += nx * k;
      B.vy += ny * k;
    }
  }

  respawnPose() {
    return { x: 0, y: 0, heading: 0 }; // field centre, facing +x
  }

  // entity placement (pursuit specs may carry monsters/pickups): monsters
  // guard POIs round-robin, pickups scatter between angularly adjacent POIs —
  // right on the routes an escape run travels. No wallGap: open terrain.
  placer(world) {
    const field = this._field;
    let guardIdx = 0;
    const settle = (x, y, r) => {
      const res = field.constrain(x, y, r);
      return { x: res.x, y: res.y };
    };
    return {
      spawnMonster(rng, type) {
        const poi = field.pois[guardIdx++ % field.pois.length];
        const solid = poi.size * 0.6;
        if (type === 'patroller') {
          // chord swept across the centre-side approach to the POI
          const dp = Math.hypot(poi.x, poi.y) || 1;
          const ix = -poi.x / dp;
          const iy = -poi.y / dp;
          const mid = settle(
            poi.x + ix * (solid + rng.range(4, 7)),
            poi.y + iy * (solid + rng.range(4, 7)),
            2,
          );
          const half = rng.range(7, 12);
          const p0 = settle(mid.x - iy * half, mid.y + ix * half, 2);
          const p1 = settle(mid.x + iy * half, mid.y - ix * half, 2);
          return { s: 0, lairX: mid.x, lairY: mid.y, px0: p0.x, py0: p0.y, px1: p1.x, py1: p1.y };
        }
        const a = rng.range(0, Math.PI * 2);
        const d = type === 'turret' ? solid + rng.range(2.5, 6) : solid + rng.range(4, 10);
        const at = settle(poi.x + Math.cos(a) * d, poi.y + Math.sin(a) * d, 2);
        return { s: 0, lairX: at.x, lairY: at.y, px0: at.x, py0: at.y, px1: at.x, py1: at.y };
      },
      spawnPickup(rng) {
        const i = rng.int(0, field.pois.length - 1);
        const a = field.pois[i];
        const b = field.pois[(i + 1) % field.pois.length];
        const t = rng.range(0.3, 0.7);
        return settle(
          a.x + (b.x - a.x) * t + rng.range(-6, 6),
          a.y + (b.y - a.y) * t + rng.range(-6, 6),
          1.2,
        );
      },
      // hard wall: ambling guards otherwise clip through the POI structures
      // and cliff ring the cars bounce off. No rng draws.
      constrainMonster(m) {
        const res = field.constrain(m.x, m.y, m.cfg.size);
        m.x = res.x;
        m.y = res.y;
      },
    };
  }

  snapshot(world, snap) {
    const r = (v) => Math.round(v * 1000) / 1000;
    snap.pursuit = {
      hunters: this.hunters.map((h) => [
        r(h.car.x),
        r(h.car.y),
        r(h.car.heading),
        h.wreckedUntil >= 0 ? 1 : 0,
      ]),
      heat: r(world.pursuit.heat),
    };
  }
}
