// Shooter mode: third-person on-foot arena survival. The avatar is a runner
// with tank controls (A/D rotate in place, W/S move along the heading) inside
// a walled pillar arena; monsters arrive in timed waves and the shared engine
// supplies weapons, damage, pickups and score. Everything mode-specific lives
// here: runner physics, the kiting bot, wave scheduling and rim placement.
//
// Determinism: all randomness comes from forks of world.rng made in build(),
// plus the EntitySystem rng handed to placer callbacks — pure (seed, spec).

import { buildArena, bounce } from '../spaces.js';
import { wrapAngle, clamp } from '../rng.js';

// Runner tuning: snappy accelerate/stop, no drift, turns in place.
const RUNNER = {
  radius: 0.8, // collision radius against walls/pillars
  uMax: 11, // m/s jog (chasers do 14: jog loses, sprint wins)
  sprintMax: 16.5, // m/s with LShift (drains the boost meter)
  reverseMax: 6.5, // m/s back-pedal (kiting gait)
  aAccel: 26, // m/s^2 toward target speed
  aBrake: 34, // m/s^2 when slowing/reversing
  turnRate: 3.0, // rad/s tank turn (independent of speed)
  dodgeSpeed: 22, // m/s burst on Space
  dodgeCooldown: 1.2, // s between dodges
  sprintDrain: 24, // boost %/s while sprinting
  boostRegen: 9, // boost %/s passive
};

export class ShooterMode {
  constructor(spec) {
    this.spec = spec;
  }

  build(world) {
    const s = this.spec.shooter;
    world.space = buildArena(world.rng.fork('arena'), {
      halfW: 42 * s.arenaScale,
      halfH: 42 * s.arenaScale,
      cornerR: 14,
      pillars: 6,
    });

    // Minimal track stand-in: recorder meta and world.js respawn read
    // world.track.{length,nearest().idx}; the renderer reads
    // track.scenery.palette for per-seed color jitter. Neutral values keep
    // resolvePalette() at the biome base plus a small seeded shift.
    const prng = world.rng.fork('scenery');
    world.track = {
      length: 0,
      nearest: () => ({ idx: 0 }),
      scenery: {
        palette: {
          grassHue: 0.31 + prng.range(-0.045, 0.045),
          grassLight: prng.range(0.32, 0.42),
          skyHue: 0.58 + prng.range(-0.05, 0.05),
          asphaltLight: prng.range(0.16, 0.24),
        },
      },
    };
    world.lap = 0;
    world.progress = 0;

    // runner avatar: plain object carrying every field the shared world /
    // scene / HUD code reads off "the car"
    this._spawnHeading = world.rng.range(-Math.PI, Math.PI);
    world.car = {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      heading: this._spawnHeading,
      u: 0,
      slip: 0,
      steer: 0,
      boost: 60,
      boosting: false,
      drifting: false,
      wallImpact: 0,
      hintIdx: 0,
    };
    this._dodgeCd = 0;

    // wave + survival state
    world.wave = 0;
    world.survivalFrames = 0;
    this._totalWaves = 0;
    this._lastFrame = -1;

    // Wave pre-seeding. EntitySystem spawns every monster during World
    // construction (right after build returns) with alive=true; waves want
    // monster i active only from frame floor(i/waveSize)*waveEveryFrames.
    // Intercept the one-time `world.entities = ...` assignment so the later
    // waves start dead with a scheduled respawnAt — EntitySystem's own
    // respawn logic then releases each wave on schedule, untouched.
    const mode = this;
    Object.defineProperty(world, 'entities', {
      configurable: true,
      enumerable: true,
      get() {
        return undefined;
      },
      set(es) {
        Object.defineProperty(world, 'entities', {
          value: es,
          writable: true,
          configurable: true,
          enumerable: true,
        });
        mode._seedWaves(es);
      },
    });

    // bot personality (per-episode, seeded)
    this._botRng = world.rng.fork('shooterBot');
    const r = () => this._botRng.next();
    this._brain = {
      fleeR: 7 + 2.5 * r(), // closer than this: run away
      combatR: 40 + 8 * r(), // face + shoot inside this (kill on approach)
      holdR: 18 + 4 * r(), // back-pedal to hold this range
      aimCone: 0.18 + 0.1 * r(), // rad of bearing error to pull the trigger
      trigger: 0.85 + 0.13 * r(), // per-frame fire prob on a solution
      epsBurst: 0.002 + 0.005 * r(), // per-frame prob of a random-action burst
      orbitSigma: 0.5 + 0.7 * r(), // strafe-orbit bias wander (OU process)
      fleeLen: 22 + Math.floor(12 * r()), // flee latch (~post-hit invuln window)
      fightLen: 40 + Math.floor(20 * r()), // stand-and-fight window
      lowAmmo: 7 + Math.floor(4 * r()),
      lowHealth: 45 + 25 * r(),
    };
    this._orbit = 0;
    this._steerState = 0;
    this._burstFrames = 0;
    this._burstKeys = null;
    this._fleeFrames = 0;
    this._fightFrames = 0;
    this._lastHp = this.spec.rules.healthMax;
    this._sprintLatch = false;
    this._stuckFrames = 0;
    this._recoverFrames = 0;
    this._recoverSide = 1;
    this._lastWantedW = false;
    world.botPolicy = 'shooter-kite';
  }

  _seedWaves(es) {
    const per = this.spec.shooter.waveEveryFrames;
    const size = Math.max(1, this.spec.shooter.waveSize);
    this._totalWaves = Math.ceil(es.monsters.length / size);
    es.monsters.forEach((m, i) => {
      const wave = Math.floor(i / size);
      if (wave > 0) {
        m.alive = false;
        m.respawnAt = wave * per;
      }
    });
  }

  // --- kiting bot ------------------------------------------------------------
  decide(world) {
    const c = world.car;
    const p = this._brain;
    const rng = this._botRng;
    const armed = world.spec.weapon.enabled;

    // strafe-orbit bias wanders as an OU process (one gauss draw per frame,
    // unconditionally, so the rng stream is a pure function of frame count)
    const dtF = 1 / 20;
    const tau = 3.5;
    this._orbit =
      this._orbit * Math.exp(-dtF / tau) +
      p.orbitSigma * Math.sqrt(1 - Math.exp((-2 * dtF) / tau)) * rng.gauss();

    // nearest living monster + local crowd pressure. A monster is a *threat*
    // when close or actually heading at us (aggroed chaser) — distant amblers
    // near their lairs aren't worth ammo at long range. rx/ry accumulate an
    // inverse-square repulsion field: fleeing from only the nearest monster
    // runs straight into its flanking packmate.
    const closing = (m, d) =>
      d < 30 || Math.cos(m.heading - Math.atan2(c.y - m.y, c.x - m.x)) > 0.5;
    let near = null;
    let nd = Infinity;
    let threat = null;
    let td = Infinity;
    let crowd = 0;
    let rx = 0;
    let ry = 0;
    for (const m of world.entities.monsters) {
      if (!m.alive) continue;
      const d = Math.hypot(m.x - c.x, m.y - c.y);
      if (d < nd) {
        nd = d;
        near = m;
      }
      if (d < td && closing(m, d)) {
        td = d;
        threat = m;
      }
      if (d < 16) crowd++;
      if (d < 26 && d > 1e-6) {
        rx += (c.x - m.x) / (d * d * d);
        ry += (c.y - m.y) / (d * d * d);
      }
    }

    const canShoot = armed && world.ammo > 0;

    // Flee/fight alternation under pressure. Chasers outrun the jog, so
    // permanent fleeing from a pack is chip-damage death, while standing
    // ground forever trades health away — so both run on latches (per-frame
    // thresholds thrash between flee and fight and never fire a shot): a
    // short flee opens distance, then a longer fight window thins the pack,
    // and any hit that lands cuts the fight short to spend the post-hit
    // invulnerability sprinting clear. Kept ahead of the burst/recovery
    // early-returns so the latches never go stale mid-noise.
    const justHit = world.health < this._lastHp;
    this._lastHp = world.health;
    if (this._fightFrames > 0) this._fightFrames--;
    if (this._fleeFrames > 0) {
      this._fleeFrames--;
      if (this._fleeFrames === 0 && canShoot) this._fightFrames = p.fightLen;
    }
    const pressed = near && (nd < p.fleeR || (crowd >= 3 && nd < 12));
    if (justHit && near) {
      this._fleeFrames = p.fleeLen;
      this._fightFrames = 0;
    } else if (pressed && this._fleeFrames <= 0 && (this._fightFrames <= 0 || !canShoot)) {
      this._fleeFrames = p.fleeLen;
    }
    const fleeing = near !== null && this._fleeFrames > 0;

    // stuck recovery: pinned against geometry while pushing forward =>
    // reverse-turn free (side from the orbit sign; no extra rng draws)
    if (this._lastWantedW && Math.abs(c.u) < 0.8) this._stuckFrames++;
    else this._stuckFrames = 0;
    if (this._recoverFrames > 0) {
      this._recoverFrames--;
      this._lastWantedW = false;
      return keysFrom({ S: true, A: this._recoverSide > 0, D: this._recoverSide < 0 });
    }
    if (this._stuckFrames > 12) {
      this._stuckFrames = 0;
      this._recoverFrames = 10;
      this._recoverSide = this._orbit >= 0 ? 1 : -1;
      this._lastWantedW = false;
      return keysFrom({ S: true, A: this._recoverSide > 0, D: this._recoverSide < 0 });
    }

    // occasional random-action burst (exploration noise for the dataset)
    if (this._burstFrames > 0) {
      this._burstFrames--;
      this._lastWantedW = !!this._burstKeys.W;
      return { ...this._burstKeys };
    }
    if (rng.next() < p.epsBurst) {
      this._burstFrames = 4 + Math.floor(rng.next() * 14);
      this._burstKeys = keysFrom({
        W: rng.bool(0.6),
        S: rng.bool(0.25),
        A: rng.bool(0.35),
        D: rng.bool(0.35),
        Space: rng.bool(0.3),
        LShiftKey: rng.bool(0.25),
        F: armed ? rng.bool(0.35) : false,
      });
      this._lastWantedW = !!this._burstKeys.W;
      return { ...this._burstKeys };
    }

    // nearest available pickup of each kind (positions from the live system)
    const nearestPickup = (kind) => {
      let best = null;
      let bd = Infinity;
      for (const pk of world.entities.pickups) {
        if (pk.kind !== kind || pk.cooldown > 0) continue;
        const d = Math.hypot(pk.x - c.x, pk.y - c.y);
        if (d < bd) {
          bd = d;
          best = pk;
        }
      }
      return best;
    };
    const goalAmmo = armed && world.ammo <= p.lowAmmo ? nearestPickup('ammo') : null;
    const goalHealth = world.health <= p.lowHealth ? nearestPickup('health') : null;
    const goal = world.health < 40 && goalHealth ? goalHealth : goalAmmo || goalHealth;

    let desired = c.heading;
    let move = 0; // 1 forward, -1 back-pedal, 0 stand
    let sprint = false;
    let dodge = false;
    const critical = (world.ammo <= 2 && goalAmmo) || (world.health <= 40 && goalHealth);

    if (fleeing) {
      // run down the pack's repulsion field (away from ALL of them), leaning
      // toward the arena centre the closer the walls get (cornered = dead);
      // detour over a pickup when one lies roughly along the escape line.
      // Dodge bursts only when the cooldown is ready (holding Space forever
      // would teach the model that Space does nothing).
      const away = rx * rx + ry * ry > 0 ? Math.atan2(ry, rx) : Math.atan2(c.y - near.y, c.x - near.x);
      // circle-kite: mostly run the tangent around the arena centre (the
      // pack strings out into a chaseable line behind) with an outward/inward
      // nudge from the repulsion field, pulled off the walls when close
      const ang = Math.atan2(c.y, c.x);
      const t1 = ang + Math.PI / 2;
      const t2 = ang - Math.PI / 2;
      const tan = Math.abs(wrapAngle(t1 - away)) <= Math.abs(wrapAngle(t2 - away)) ? t1 : t2;
      desired = wrapAngle(tan + wrapAngle(away - tan) * 0.35);
      const wallDist = Math.min(
        world.space.halfW - Math.abs(c.x),
        world.space.halfH - Math.abs(c.y),
      );
      const wallness = clamp(1 - wallDist / 16, 0, 1);
      const toCenter = Math.atan2(-c.y, -c.x);
      desired = wrapAngle(desired + wrapAngle(toCenter - desired) * 0.65 * wallness);
      if (goal) {
        const toGoal = Math.atan2(goal.y - c.y, goal.x - c.x);
        if (Math.abs(wrapAngle(toGoal - desired)) < 1.1) desired = toGoal;
      }
      move = 1;
      sprint = true;
      dodge = nd < 6.5 && this._dodgeCd <= 0;
    } else if (critical) {
      // out of ammo / nearly dead: resupply overrides fighting
      const g = world.ammo <= 2 && goalAmmo ? goalAmmo : goalHealth;
      desired = Math.atan2(g.y - c.y, g.x - c.x);
      move = 1;
      sprint = near !== null && nd < 22;
    } else if (threat && td < p.combatR && canShoot) {
      // combat band (the default stance): face the incoming monster and kill
      // it on approach; back-pedal to hold range while the shared weapon
      // logic fires down the barrel; dodge-hop out of point-blank contact
      desired = Math.atan2(threat.y - c.y, threat.x - c.x);
      move = td < p.holdR ? -1 : 0;
      dodge = td < 6 && this._dodgeCd <= 0; // backward hop while back-pedaling
    } else if (goal) {
      // topping up between engagements
      desired = Math.atan2(goal.y - c.y, goal.x - c.x);
      move = 1;
      sprint = near !== null && nd < 20;
    } else if (near) {
      // far (or dry): approach with a wandering orbit bias for varied arcs;
      // without ammo keep more distance instead of walking into contact
      const to = Math.atan2(near.y - c.y, near.x - c.x);
      const bias = clamp(this._orbit, -1.2, 1.2);
      desired = canShoot ? to + bias * 0.9 : wrapAngle(to + Math.PI + bias * 0.7);
      move = canShoot || nd > p.combatR ? 1 : 0;
    } else {
      // lull between waves: wander (keeps optical flow in the dataset)
      const fromCenter = Math.hypot(c.x, c.y);
      desired =
        fromCenter > world.space.halfW * 0.6
          ? Math.atan2(-c.y, -c.x)
          : c.heading + clamp(this._orbit, -1, 1) * 0.7;
      move = 1;
    }

    // never run a forward heading into a pillar or wall (a runner pinned
    // against geometry mid-flee is how the swarm wins)
    if (move === 1) {
      const cap = goal ? Math.hypot(goal.x - c.x, goal.y - c.y) * 0.8 : Infinity;
      desired = this._avoid(world, c, desired, cap);
    }

    // tank steering with hysteresis (discrete A/D, no flapping)
    const err = wrapAngle(desired - c.heading);
    const on = 0.09;
    if (this._steerState === 0) {
      if (err > on) this._steerState = 1;
      else if (err < -on) this._steerState = -1;
    } else if (this._steerState === 1 && err < on * 0.35) {
      this._steerState = err < -on ? -1 : 0;
    } else if (this._steerState === -1 && err > -on * 0.35) {
      this._steerState = err > on ? 1 : 0;
    }

    // only commit to a translation roughly along the desired direction;
    // when fleeing, any forward motion within a quarter turn still helps
    const W = move === 1 && Math.abs(err) < (fleeing ? 1.45 : 1.15);
    const S = move === -1 && Math.abs(err) < 0.9;

    // sprint latch: engage on a healthy meter, hold until it empties —
    // threshold-flicker (LShift toggling every frame) is useless as data
    let LShiftKey = false;
    if (sprint && W) {
      LShiftKey = this._sprintLatch ? c.boost > 2 : c.boost > 25;
    }
    this._sprintLatch = LShiftKey;
    this._lastWantedW = W;

    // fire on any threatening monster roughly down the barrel
    let F = false;
    if (canShoot) {
      for (const m of world.entities.monsters) {
        if (!m.alive) continue;
        const dx = m.x - c.x;
        const dy = m.y - c.y;
        const d = Math.hypot(dx, dy);
        if (d > 55 || !closing(m, d)) continue;
        if (Math.abs(wrapAngle(Math.atan2(dy, dx) - c.heading)) < p.aimCone) {
          F = rng.next() < p.trigger; // rng draw only on an actual solution
          break;
        }
      }
    }

    return keysFrom({
      W,
      S,
      A: this._steerState > 0,
      D: this._steerState < 0,
      Space: dodge,
      LShiftKey,
      F,
    });
  }

  // deflect a movement heading so a short forward probe stays clear of
  // pillars and walls (probe capped so pickup approaches aren't deflected)
  _avoid(world, c, desired, cap = Infinity) {
    const probe = Math.min(7 + 0.35 * Math.max(0, c.u), cap);
    if (probe < 2) return desired;
    for (let k = 0; k < 3; k++) {
      const px = c.x + Math.cos(desired) * probe;
      const py = c.y + Math.sin(desired) * probe;
      const res = world.space.constrain(px, py, 2.2);
      if (!res.hit) break;
      // steer onto the obstacle tangent closest to the current heading
      const na = Math.atan2(res.ny, res.nx);
      const t1 = na + Math.PI / 2;
      const t2 = na - Math.PI / 2;
      desired =
        Math.abs(wrapAngle(t1 - desired)) <= Math.abs(wrapAngle(t2 - desired)) ? t1 : t2;
    }
    return wrapAngle(desired);
  }

  // --- runner physics (one 60 Hz substep) -------------------------------------
  stepAvatar(world, keys, dt) {
    const c = world.car;
    const R = RUNNER;
    c.wallImpact = 0;
    if (this._dodgeCd > 0) this._dodgeCd = Math.max(0, this._dodgeCd - dt);

    // tank turn: heading rotates directly from A/D, even at a standstill
    const turn = (keys.A ? 1 : 0) - (keys.D ? 1 : 0);
    c.heading = wrapAngle(c.heading + turn * R.turnRate * dt);
    // steer field kept only for telemetry/visual lean
    c.steer += clamp(turn * 0.4 - c.steer, -8 * dt, 8 * dt);

    // sprint reuses the boost meter so the shared HUD boost bar stays live
    c.boosting = false;
    let uMax = R.uMax;
    if (keys.LShiftKey && c.boost > 0.5 && !keys.S) {
      c.boosting = true;
      uMax = R.sprintMax;
      c.boost = Math.max(0, c.boost - R.sprintDrain * dt);
    } else {
      c.boost = Math.min(100, c.boost + R.boostRegen * dt);
    }

    // dodge: an instant speed burst with a cooldown (decays via aBrake below)
    if (keys.Space && this._dodgeCd <= 0) {
      this._dodgeCd = R.dodgeCooldown;
      c.u = keys.S && !keys.W ? -R.dodgeSpeed * 0.7 : R.dodgeSpeed;
    }

    // forward speed approaches the commanded target (snappy, no coasting)
    const target = keys.W ? uMax : keys.S ? -R.reverseMax : 0;
    c.u += clamp(target - c.u, -R.aBrake * dt, R.aAccel * dt);
    if (target === 0 && Math.abs(c.u) < 0.1) c.u = 0;

    // velocity strictly along the heading (infinite grip: feet, not tires)
    const cos = Math.cos(c.heading);
    const sin = Math.sin(c.heading);
    c.vx = c.u * cos;
    c.vy = c.u * sin;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.slip = 0;
    c.drifting = false;

    // arena walls + pillars
    const res = world.space.constrain(c.x, c.y, R.radius);
    const impact = bounce(c, res, 0.25, 0.8);
    if (impact > 0) {
      c.wallImpact = impact;
      c.u = c.vx * cos + c.vy * sin; // keep only the surviving forward part
    }
    return res;
  }

  postStep(world, keys, dt, frameEvents) {
    // wave activation: monsters release themselves via respawnAt; here we
    // advance the public wave counter and announce it (once per boundary —
    // the while-loop also catches up across death-freeze gaps)
    const per = this.spec.shooter.waveEveryFrames;
    while (world.wave < this._totalWaves && world.frame >= world.wave * per) {
      world.wave++;
      frameEvents.push({ name: 'WaveStarted', data: { wave: world.wave } });
    }

    // survival scoring: +10 per second stayed alive, event-free (postStep
    // runs once per substep and only while alive, so gate on the frame index)
    if (world.frame !== this._lastFrame) {
      this._lastFrame = world.frame;
      world.survivalFrames++;
      if (world.survivalFrames % 20 === 0) world.score += 10;
    }
  }

  respawnPose(world) {
    // adrenaline refill: without sprint the runner can't break a centre camp
    world.car.boost = Math.max(world.car.boost, 60);
    return { x: 0, y: 0, heading: this._spawnHeading };
  }

  // entity placement: monsters on the arena rim, pickups scattered inside,
  // patrollers sweeping a chord between two rim points
  placer(world) {
    const space = world.space;

    // seeded point just inside the walls: inset >= cornerR*(1-1/sqrt(2)) keeps
    // the rounded corners covered, so every draw lands inside the arena.
    // Monster lairs advance around the rim by the golden angle (plus jitter)
    // so a wave surrounds the player instead of clumping into one death-ball.
    let spawnIdx = 0;
    const rimPoint = (rng, baseA) => {
      const a = baseA !== undefined ? baseA + rng.range(-0.35, 0.35) : rng.range(0, Math.PI * 2);
      const inset = rng.range(5, 8);
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const t = Math.min(
        (space.halfW - inset) / Math.max(Math.abs(dx), 1e-6),
        (space.halfH - inset) / Math.max(Math.abs(dy), 1e-6),
      );
      return { x: dx * t, y: dy * t };
    };

    return {
      spawnMonster(rng, type) {
        const lair = rimPoint(rng, spawnIdx++ * 2.39996); // golden angle
        // patroller endpoints: a chord between two rim points
        const p0 = type === 'patroller' ? rimPoint(rng) : lair;
        const p1 = type === 'patroller' ? rimPoint(rng) : lair;
        return {
          s: 0,
          lairX: type === 'patroller' ? p0.x : lair.x,
          lairY: type === 'patroller' ? p0.y : lair.y,
          px0: p0.x,
          py0: p0.y,
          px1: p1.x,
          py1: p1.y,
        };
        // no wallGap: arena monsters never hover over walls
      },
      spawnPickup(rng) {
        // rejection-sample away from pillars (bounded, deterministic draws)
        for (let i = 0; i < 8; i++) {
          const pt = space.randomPoint(rng, 7);
          let clear = true;
          for (const o of space.obstacles) {
            if (Math.hypot(pt.x - o.x, pt.y - o.y) < o.radius + 1.6) {
              clear = false;
              break;
            }
          }
          if (clear) return pt;
        }
        return { x: 0, y: 0 }; // arena centre is always pillar-free
      },
    };
  }

  snapshot(world, snap) {
    let alive = 0;
    for (const m of world.entities.monsters) if (m.alive) alive++;
    snap.shooter = { wave: world.wave, alive };
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
    F: !!partial.F,
  };
}
