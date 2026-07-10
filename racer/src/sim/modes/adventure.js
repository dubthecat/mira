// Adventure mode: open-world exploration/collection. The avatar roams a
// circular open field (cliff ring boundary, solid POI structures), finds
// relics placed at guarded points of interest and collects them all — a
// condensed action-RPG loop whose recorded gameplay teaches a world model
// long-range navigation toward visible beacons.
//
// Determinism: all randomness comes from world.rng (buildOpenField) or forks
// made in build() (relic shuffle, bot personality/noise), in a call order
// that is a pure function of (seed, spec).

import { buildOpenField, bounce } from '../spaces.js';
import { Car, carParamsFor } from '../car.js';
import { wrapAngle } from '../rng.js';

const COLLECT_RADIUS = 4; // metres: relic pickup proximity
const COMPLETE_BONUS = 500;
const RELIC_SCORE = 150;

// The Car requires a track for its wall branch; open terrain has none. This
// stub satisfies the Car contract with halfWidth=Infinity so the wall code
// never fires — field boundaries and POI structures are enforced in
// stepAvatar via spaces.bounce instead. length/scenery keep the recorder page
// and palette resolution working unchanged (palette values equal the
// trackless defaults in scene.js, so visuals stay biome-pure).
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

export class AdventureMode {
  constructor(spec) {
    this.spec = spec;
  }

  build(world) {
    const adv = this.spec.adventure;
    const extent = 240 * adv.worldScale;
    const field = buildOpenField(world.rng, {
      extent,
      pois: Math.max(adv.relics + 2, 8),
    });
    world.space = field;
    this._field = field;

    // avatar: the shared car body. onFoot only rescales params — a slow,
    // punchy "runner" that keeps the exact same discrete-key dynamics.
    let params = carParamsFor(this.spec);
    if (adv.onFoot) {
      params = {
        ...params,
        uMax: params.uMax * 0.35,
        uMaxBoost: params.uMaxBoost * 0.35,
        aEngine: params.aEngine * 1.5,
      };
    }
    const stub = stubTrack(0, 0, 0); // spawn at field centre facing +x
    world.track = stub; // recorder/HUD read track.length; minimap guards on .xs
    world.car = new Car(stub, 0, params);
    world.progress = 0; // odometer (metres travelled), for meta/gates parity

    // --- relics: a seeded shuffle of the POIs, one relic per chosen POI.
    // The relic sits just OUTSIDE its POI's solid radius (structures are
    // impassable and can be wider than the 4 m collect radius), offset in a
    // seeded direction — visually "at the ruin", physically reachable.
    const rng = world.rng.fork('adventure');
    const order = field.pois.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    this._relicPois = order.slice(0, adv.relics).map((i) => field.pois[i]);
    world.relics = this._relicPois.map((poi) => {
      const a = rng.range(0, Math.PI * 2);
      const d = poi.size * 0.6 + 1.6;
      let x = poi.x + Math.cos(a) * d;
      let y = poi.y + Math.sin(a) * d;
      // insurance against rim/neighbour-POI overlap
      const res = field.constrain(x, y, 0.8);
      x = res.x;
      y = res.y;
      // bot approach point: a touch further out along the same radial, so
      // pursuit aims at open ground and collection triggers on the way in
      const dd = Math.hypot(x - poi.x, y - poi.y) || 1;
      return {
        x,
        y,
        collected: false,
        gx: x + ((x - poi.x) / dd) * 1.5,
        gy: y + ((y - poi.y) / dd) * 1.5,
      };
    });

    world.objective = {
      collected: 0,
      total: world.relics.length,
      targetX: 0,
      targetY: 0,
      targetIdx: -1,
    };
    this._completed = false;
    this._retarget(world);

    // --- explorer bot personality + state (fork made in build: deterministic)
    this._rng = world.rng.fork('adv-bot');
    const r = () => this._rng.next();
    this._p = {
      vMax: 22 + 12 * r(),
      steerOn: 0.05 + 0.05 * r(), // rad of heading error to press A/D
      fight: r() < 0.75, // armed personalities mostly engage guards
      trigger: 0.35 + 0.55 * r(), // per-frame prob of firing when lined up
      epsBurst: 0.002 + 0.006 * r(), // random-action burst probability
      boostiness: 0.1 + 0.6 * r(),
      engageRange: 40 + 25 * r(), // how far out we notice guards
      standoff: 15 + 8 * r(), // preferred stop-and-shoot distance
    };
    this._steerState = 0;
    this._burstFrames = 0;
    this._burstKeys = null;
    this._stuckFrames = 0;
    this._recoverFrames = 0;
    this._recoverSteer = 1;
    this._roamIdx = 0; // post-completion sightseeing waypoint
    this._combatFrames = 0; // continuous-fight clock -> forces a push-through
    this._pushFrames = 0; // frames left of "ignore guards, dive for the relic"
    this._orbitFrames = 0; // close-but-misaligned clock (turning-circle trap)
    this._seek = null; // pickup-seeking state: null | 'health' | 'ammo'
    this._avoidSide = 0; // committed skirt side around an obstacle (0 | +-1)
    this._avoidHold = 0; // frames the committed side is held
    this._wasDead = false;
    this._deathsOnTarget = 0; // deaths since the objective last changed
    this._lastTargetIdx = -2;
    this._lastCollected = 0;
  }

  // nearest uncollected relic from the avatar becomes the objective target
  _retarget(world) {
    const o = world.objective;
    let best = -1;
    let bestD2 = Infinity;
    for (let i = 0; i < world.relics.length; i++) {
      const rl = world.relics[i];
      if (rl.collected) continue;
      const dx = rl.x - world.car.x;
      const dy = rl.y - world.car.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    if (best >= 0) {
      o.targetIdx = best;
      o.targetX = world.relics[best].x;
      o.targetY = world.relics[best].y;
    }
    // all collected: keep the last target frozen (renderer hides all beams)
  }

  decide(world) {
    const car = world.car;
    const p = this._p;
    const rng = this._rng;
    const field = this._field;
    const armed = !!world.spec.weapon.enabled;
    const u = car.u;

    // dead: hold nothing (avatar is frozen; don't wind up stuck counters)
    if (world.respawnSub > 0) {
      this._stuckFrames = 0;
      if (!this._wasDead) {
        this._wasDead = true;
        this._deathsOnTarget++;
      }
      return keysFrom({});
    }
    this._wasDead = false;

    // --- goal: current relic's approach point; pickups override when low;
    // after completion, sightsee between POIs so the data stays in motion
    const o = world.objective;
    // dash-grab escalation: dying twice on the same objective means careful
    // play isn't working — commit to a full-speed drive-by (the 4 m collect
    // radius rewards it) instead of another losing firefight
    if (o.targetIdx !== this._lastTargetIdx || o.collected !== this._lastCollected) {
      this._lastTargetIdx = o.targetIdx;
      this._lastCollected = o.collected;
      this._deathsOnTarget = 0;
    }
    const dash = this._deathsOnTarget >= 2 && o.collected < o.total;
    let gx;
    let gy;
    if (o.collected < o.total) {
      const rl = world.relics[o.targetIdx];
      gx = rl.gx;
      gy = rl.gy;
    } else {
      const poi = field.pois[this._roamIdx % field.pois.length];
      const dp = Math.hypot(poi.x, poi.y) || 1;
      // stand-off point on the centre side of the (solid) structure
      gx = poi.x - (poi.x / dp) * (poi.size * 0.6 + 6);
      gy = poi.y - (poi.y / dp) * (poi.size * 0.6 + 6);
      if (Math.hypot(gx - car.x, gy - car.y) < 12) {
        this._roamIdx = (this._roamIdx + 1) % field.pois.length;
      }
    }
    // pickup seeking with hysteresis (enter low, exit topped-up) so the bot
    // never ping-pongs between a guarded relic and a distant pickup; a nearly
    // reached relic is always finished first
    if (this._seek === 'health' && world.health >= 70) this._seek = null;
    if (this._seek === 'ammo' && (!armed || world.ammo >= 8)) this._seek = null;
    if (!this._seek && !dash && Math.hypot(gx - car.x, gy - car.y) > 25) {
      if (world.health < 40) this._seek = 'health';
      else if (armed && world.ammo < 3) this._seek = 'ammo';
    }
    if (this._seek) {
      let bestD2 = 130 * 130;
      let found = false;
      for (const pk of world.entities.pickups) {
        if (pk.kind !== this._seek || pk.cooldown > 0) continue;
        const dx = pk.x - car.x;
        const dy = pk.y - car.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          gx = pk.x;
          gy = pk.y;
          found = true;
        }
      }
      if (!found) this._seek = null; // nothing reachable: back to the relic
    }

    // --- stuck / recovery: reverse while steering the nose back toward goal
    let alpha = wrapAngle(Math.atan2(gy - car.y, gx - car.x) - car.heading);
    const distGoal = Math.hypot(gx - car.x, gy - car.y);
    if (this._recoverFrames > 0) {
      this._recoverFrames--;
      return keysFrom({ S: true, A: this._recoverSteer > 0, D: this._recoverSteer < 0 });
    }
    if (Math.abs(u) < 1.2) this._stuckFrames++;
    else this._stuckFrames = 0;
    // orbit trap: a goal closer than the minimum turning radius (~4.2 m) but
    // off-axis can never be reached by driving forward — the car circles it
    // forever. Detect "close but persistently misaligned" and back up.
    if (distGoal < 8 && Math.abs(alpha) > 0.9) this._orbitFrames++;
    else this._orbitFrames = 0;
    if (this._stuckFrames > 26 || this._orbitFrames > 20) {
      this._stuckFrames = 0;
      this._orbitFrames = 0;
      this._recoverFrames = 18;
      // reversing flips turn direction: steer A (left) swings the nose right
      this._recoverSteer = alpha < 0 ? 1 : -1;
      return keysFrom({ S: true, A: this._recoverSteer > 0, D: this._recoverSteer < 0 });
    }

    // --- occasional random-action burst (exploration noise / data diversity)
    if (this._burstFrames > 0) {
      this._burstFrames--;
      return { ...this._burstKeys };
    }
    if (rng.next() < p.epsBurst && Math.abs(u) > 4) {
      this._burstFrames = 5 + Math.floor(rng.next() * 14);
      this._burstKeys = keysFrom({
        W: rng.bool(0.6),
        S: rng.bool(0.2),
        A: rng.bool(0.35),
        D: rng.bool(0.35),
        Space: rng.bool(0.2),
        LShiftKey: rng.bool(0.2),
        F: armed ? rng.bool(0.3) : false,
      });
      this._burstFrames--;
      return { ...this._burstKeys };
    }

    // --- combat: fighters stop and shoot guards near the goal (or anything
    // right on top of us); non-fighters rely on the dodge below. Guards
    // respawn at their lairs, so an endless fight is possible — after ~4.5 s
    // of continuous combat we force a push-through window that ignores them
    // and dives for the relic instead.
    if (this._pushFrames > 0) this._pushFrames--;
    if (armed && p.fight && world.ammo > 0 && this._pushFrames <= 0 && !dash) {
      let target = null;
      let targetD = Infinity;
      for (const m of world.entities.monsters) {
        if (!m.alive) continue;
        const dCar = Math.hypot(m.x - car.x, m.y - car.y);
        const dGoal = Math.hypot(m.x - gx, m.y - gy);
        if (dCar < p.engageRange && (dGoal < 26 || dCar < 15) && dCar < targetD) {
          target = m;
          targetD = dCar;
        }
      }
      if (target) {
        if (++this._combatFrames > 90) {
          this._combatFrames = 0;
          this._pushFrames = 90;
        }
        const beta = wrapAngle(Math.atan2(target.y - car.y, target.x - car.x) - car.heading);
        this._applySteerHysteresis(beta);
        return keysFrom({
          W: targetD > p.standoff + 8 && Math.abs(beta) < 0.9,
          S: targetD < p.standoff - 4 && u > 3,
          A: this._steerState > 0,
          D: this._steerState < 0,
          F: Math.abs(beta) < 0.2 && rng.next() < p.trigger,
        });
      }
      this._combatFrames = 0;
    } else if (distGoal > 15) {
      // flee/drive-past: bias the goal bearing away from a monster dead
      // ahead — but inside 15 m of the goal, commit to the grab instead
      let dodge = 0;
      for (const m of world.entities.monsters) {
        if (!m.alive || m.type === 'turret') continue;
        const d = Math.hypot(m.x - car.x, m.y - car.y);
        if (d > 15) continue;
        const beta = wrapAngle(Math.atan2(m.y - car.y, m.x - car.x) - car.heading);
        if (Math.abs(beta) < 0.8) dodge = beta > 0 ? -1.1 : 1.1;
      }
      alpha = wrapAngle(alpha + dodge);
    }

    // --- obstacle avoidance: probe ahead through space.constrain; POI
    // structures and the cliff ring are solid, so steer around, not into.
    // Probe with the car's own radius (a fatter probe falsely flags the relic
    // spot itself, which sits right at a structure's edge), shorten it near
    // the goal, and drop avoidance entirely on final approach — bounce is
    // soft and the collect radius is generous. When blocked, steer along the
    // obstacle's tangent (constrain hands us the outward normal) and COMMIT
    // to that side for a while — re-choosing every frame dithers into the
    // rock when the goal sits dead behind it.
    const probeLen = Math.min(8 + 0.25 * Math.max(u, 0), Math.max(3, distGoal - 1));
    let blocked = false;
    if (this._avoidHold > 0) this._avoidHold--;
    if (distGoal > 10) {
      const res = field.constrain(
        car.x + Math.cos(car.heading) * probeLen,
        car.y + Math.sin(car.heading) * probeLen,
        car.p.radius,
      );
      if (res.hit) {
        blocked = true;
        if (this._avoidSide === 0 || this._avoidHold === 0) {
          // side whose tangent points closer to the goal
          const gdx = (gx - car.x) / (distGoal || 1);
          const gdy = (gy - car.y) / (distGoal || 1);
          this._avoidSide = -res.ny * gdx + res.nx * gdy >= 0 ? 1 : -1;
          this._avoidHold = 30;
        }
        // skirt direction: tangent, biased outward off the surface
        const tx = -res.ny * this._avoidSide + res.nx * 0.55;
        const ty = res.nx * this._avoidSide + res.ny * 0.55;
        alpha = wrapAngle(Math.atan2(ty, tx) - car.heading);
      }
    }
    if (!blocked && this._avoidHold === 0) this._avoidSide = 0;

    this._applySteerHysteresis(alpha);

    // --- throttle by alignment; slow near the goal and when blocked
    let vTarget = p.vMax / (1 + 2.2 * alpha * alpha);
    if (distGoal < 18 && !dash) vTarget = Math.min(vTarget, 9 + distGoal * 0.5);
    if (blocked) vTarget = Math.min(vTarget, 9);
    const W = u < vTarget * 0.96;
    const S = u > vTarget * 1.15 + 1;

    const LShiftKey =
      !blocked &&
      Math.abs(alpha) < 0.08 &&
      (distGoal > 70 || (dash && distGoal > 25)) &&
      car.boost > 30 &&
      u > 0.5 * p.vMax &&
      rng.next() < p.boostiness;

    // opportunistic fire at anything down the barrel (fighters and cowards)
    let F = false;
    if (armed && world.ammo > 0) {
      for (const m of world.entities.monsters) {
        if (!m.alive) continue;
        const dx = m.x - car.x;
        const dy = m.y - car.y;
        if (dx * dx + dy * dy > 55 * 55) continue;
        if (Math.abs(wrapAngle(Math.atan2(dy, dx) - car.heading)) < 0.2) {
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

  stepAvatar(world, keys, dt) {
    const car = world.car;
    const q = car.step(keys, dt); // stub track: wall branch never fires
    // field constraints: cliff ring + solid POI structures
    const res = this._field.constrain(car.x, car.y, car.p.radius);
    const impact = bounce(car, res, car.p.wallRestitution, car.p.wallTangentKeep);
    if (impact > 0) car.wallImpact = Math.max(car.wallImpact, impact);
    return q;
  }

  postStep(world, keys, dt, frameEvents) {
    const car = world.car;
    world.progress += Math.hypot(car.vx, car.vy) * dt; // odometer

    // relic proximity + objective retargeting
    const o = world.objective;
    for (let i = 0; i < world.relics.length; i++) {
      const rl = world.relics[i];
      if (rl.collected) continue;
      const dx = car.x - rl.x;
      const dy = car.y - rl.y;
      if (dx * dx + dy * dy < COLLECT_RADIUS * COLLECT_RADIUS) {
        rl.collected = true;
        o.collected++;
        world.score += RELIC_SCORE;
        frameEvents.push({ name: 'RelicCollected', data: { index: i, collected: o.collected } });
        if (o.collected >= o.total && !this._completed) {
          this._completed = true;
          world.score += COMPLETE_BONUS;
          frameEvents.push({ name: 'AdventureComplete', data: { score: world.score } });
        }
        this._retarget(world);
      }
    }
  }

  respawnPose() {
    return { x: 0, y: 0, heading: 0 }; // field centre, facing +x
  }

  // entity placement: monsters guard relic POIs, pickups scatter along the
  // ring between POIs. No wallGap — chasers here never hover walls.
  placer(world) {
    const field = this._field;
    const relicPois = this._relicPois;
    let guardIdx = 0; // round-robin so guards spread across all relics

    // keep spawn points out of solids and inside the rim
    const settle = (x, y, r) => {
      const res = field.constrain(x, y, r);
      return { x: res.x, y: res.y };
    };

    return {
      spawnMonster(rng, type) {
        const poi = relicPois[guardIdx++ % relicPois.length];
        const solid = poi.size * 0.6;
        if (type === 'patroller') {
          // chord swept across the approach to the POI (the path a collector
          // drives), a moving gate in front of the relic
          const dp = Math.hypot(poi.x, poi.y) || 1;
          const ix = -poi.x / dp; // toward the field centre
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
        // between two angularly adjacent POIs (poi list is angle-ordered),
        // right on the routes a collector travels
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
      // hard wall: guard lairs sit 4-10 m from POI centres while the amble
      // orbit reaches ~11 m, so unconstrained guards sink into the solid
      // structures the car collides with. No rng draws.
      constrainMonster(m) {
        const res = field.constrain(m.x, m.y, m.cfg.size);
        m.x = res.x;
        m.y = res.y;
      },
      // no wallGap: open terrain has no wall line for chasers to hover
    };
  }

  snapshot(world, snap) {
    const o = world.objective;
    const r = (v) => Math.round(v * 1000) / 1000;
    snap.adventure = {
      collected: o.collected,
      total: o.total,
      target: [r(o.targetX), r(o.targetY)],
    };
  }
}
