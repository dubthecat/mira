// Soccer mode: rocket-league-style car soccer. The mode owns a rounded-rect
// arena with two open goal mouths, a rolling ball, and 0-2 rival cars driven
// by their own ball-chasing policies. The shared engine still owns weapons,
// monsters, pickups and health — soccer specs usually leave those empty, but
// the placer keeps them working when present.
//
// Geometry convention: the player ("us") defends the goal at x = -halfW and
// attacks the goal at x = +halfW; kickoff heading 0 points at the target goal.
//
// Determinism: every random draw comes from world.rng or forks made in
// build(), in a call order that is a pure function of (seed, spec).

import { buildArena, bounce, clampMag } from '../spaces.js';
import { Car, carParamsFor } from '../car.js';
import { wrapAngle, clamp } from '../rng.js';

const SUBSTEPS = 3; // world.js steps the mode 3x per 20 Hz action frame
const KICKOFF_FREEZE_FRAMES = 30; // countdown after build and after each goal
const NET_DEPTH = 3.2; // metres of net box behind the goal line cars may enter

const BALL = {
  radius: 1.3,
  friction: 0.5, // 1/s exponential rolling-speed decay
  vMax: 52,
  restitution: 0.72, // livelier than a car off the arena walls
  tangentKeep: 0.985,
  kick: 1.5, // ball impulse per m/s of closing speed
  powerKick: 1.6, // multiplier when the kicker holds boost at contact
  carContactR: 1.5, // car body radius for kicking purposes
};

const EMPTY_KEYS = { W: false, S: false, A: false, D: false, Space: false, LShiftKey: false, F: false };

// Car.step queries this.track for wall collisions; arena play has no
// centerline track, so cars get a stub whose wall never exists
// (halfWidth = Infinity) and the mode applies arena walls via spaces.bounce.
function freeTrack(x, y, heading) {
  const q = { s: 0, idx: 0, lateral: 0, halfWidth: Infinity, theta: heading, x, y, kappa: 0 };
  return { length: 0, sampleAt: () => q, nearest: () => q };
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

// Per-driver "personality" — skill scales how clean the aim is, the rest adds
// data-diversity noise exactly like the circuit BotDriver's parameters.
function personality(rng, skill) {
  return {
    skill,
    steerOn: 0.05 + 0.06 * rng.next(), // rad of pursuit error to press A/D
    approach: 4.5 + 3.5 * rng.next(), // how far behind the ball to swing
    leadScale: 0.7 + 0.6 * rng.next(), // ball-velocity lead multiplier
    aimErr: (rng.next() - 0.5) * 10 * (1 - skill), // lateral shot error (m)
    tempo: 0.3 + 0.7 * skill, // low tempo = shadows goal-side instead of charging
    boostiness: (0.25 + 0.65 * rng.next()) * (0.3 + 0.7 * skill),
    driftiness: rng.next() * rng.next(),
    epsBurst: 0.002 + 0.005 * rng.next(), // random-action burst probability
    // attention lapses: sloppy drivers periodically ease off and wander for a
    // couple of seconds (skilled drivers never do) — openings a striker can use
    lapseEvery: Math.round(240 + 160 * rng.next()),
    lapseLen: skill > 0.8 ? 0 : Math.round((60 + 40 * rng.next()) * (1.05 - skill)),
    lapsePhase: Math.round(rng.next() * 200),
  };
}

// Shared ball-chasing policy (player bot AND rivals): get behind the ball
// relative to the goal it attacks, then drive through it; boost on lined-up
// shots; reverse out when stuck or when the ball ends up behind the car.
// Emits discrete keys only — the exact action set the world model trains on.
class BallChaser {
  constructor(rng, goalX, arena, p, armed = false) {
    this.rng = rng;
    this.goalX = goalX; // x of the goal this driver ATTACKS
    this.arena = arena;
    this.p = p;
    this.armed = armed;
    this.steerState = 0; // -1, 0, +1 with hysteresis
    this.stuckFrames = 0;
    this.recoverFrames = 0;
    this.recoverSteer = 1;
    this.recoverFwd = false;
    this.burstFrames = 0;
    this.burstKeys = null;
    this.clock = 0; // decide() calls; drives the shadow-position wobble
  }

  // car: the body this brain drives; ball: mode ball; others: opposing cars
  decide(car, ball, others = []) {
    const p = this.p;
    const rng = this.rng;
    const u = car.u;
    this.clock++;

    // reversing into a wall deadlocks — check clearance behind the tail first
    const rearX = car.x - Math.cos(car.heading) * 5;
    const rearY = car.y - Math.sin(car.heading) * 5;
    const rearBlocked =
      Math.abs(rearX) > this.arena.halfW - 2 || Math.abs(rearY) > this.arena.halfH - 2;

    // --- stuck recovery: swing off walls / the ball, backwards when there is
    // room behind, forwards on full lock when the wall is at our tail
    if (Math.abs(u) < 1.1) this.stuckFrames++;
    else this.stuckFrames = 0;
    if (this.recoverFrames > 0) {
      this.recoverFrames--;
      if (this.recoverFwd) {
        return keysFrom({ W: true, A: this.recoverSteer > 0, D: this.recoverSteer < 0 });
      }
      return keysFrom({ S: true, A: this.recoverSteer > 0, D: this.recoverSteer < 0 });
    }
    if (this.stuckFrames > 26) {
      this.stuckFrames = 0;
      this.recoverFrames = 20;
      const err = wrapAngle(Math.atan2(ball.y - car.y, ball.x - car.x) - car.heading);
      this.recoverFwd = rearBlocked;
      // while reversing, opposite steer swings the nose back toward the ball
      this.recoverSteer = this.recoverFwd ? (err > 0 ? 1 : -1) : err > 0 ? -1 : 1;
      this.recoverFrames--;
      if (this.recoverFwd) {
        return keysFrom({ W: true, A: this.recoverSteer > 0, D: this.recoverSteer < 0 });
      }
      return keysFrom({ S: true, A: this.recoverSteer > 0, D: this.recoverSteer < 0 });
    }

    // --- attention lapse: ease off and wander (deterministic clockwork)
    if (p.lapseLen > 0) {
      const phase = (this.clock + p.lapsePhase) % p.lapseEvery;
      if (phase < p.lapseLen) {
        return keysFrom({ W: phase % 17 < 5, A: phase % 29 < 7, D: phase % 23 < 4 });
      }
    }

    // --- occasional random-action burst (exploration noise for the dataset)
    if (this.burstFrames > 0) {
      this.burstFrames--;
      return { ...this.burstKeys };
    }
    if (rng.next() < p.epsBurst && Math.abs(u) > 4) {
      this.burstFrames = 4 + Math.floor(rng.next() * 12);
      this.burstKeys = keysFrom({
        W: rng.bool(0.65),
        S: rng.bool(0.15),
        A: rng.bool(0.35),
        D: rng.bool(0.35),
        Space: rng.bool(0.2),
        LShiftKey: rng.bool(0.25),
        F: this.armed ? rng.bool(0.3) : false,
      });
      return { ...this.burstKeys };
    }

    // --- predicted ball + shot line from the goal through the ball
    const dxb = ball.x - car.x;
    const dyb = ball.y - car.y;
    const distB = Math.hypot(dxb, dyb);
    const lead = clamp(distB / 30, 0.05, 0.5) * p.leadScale;
    const bx = ball.x + ball.vx * lead;
    const by = ball.y + ball.vy * lead;
    // aim at the corner of the mouth away from the nearest blocker, plus the
    // personality's aim error — shots and clearances avoid the rival's lane
    let aimY = p.aimErr;
    let blocker = null;
    let bestD = Infinity;
    for (const oc of others) {
      const dd = Math.hypot(oc.x - bx, oc.y - by);
      if (dd < bestD) {
        bestD = dd;
        blocker = oc;
      }
    }
    if (blocker && bestD < 45) {
      // blocker's distance from the direct shot lane: a rival parked in the
      // lane means aim wide (bounce it in off the end wall / far post), an
      // off-lane rival just biases the shot toward the open corner
      const lx = this.goalX - bx;
      const ly = -by;
      const ll2 = lx * lx + ly * ly || 1;
      const t = clamp(((blocker.x - bx) * lx + (blocker.y - by) * ly) / ll2, 0, 1);
      const laneDist = Math.hypot(blocker.x - (bx + lx * t), blocker.y - (by + ly * t));
      const wide = laneDist < 7 ? 1.25 : 0.45;
      aimY += (blocker.y >= by ? -1 : 1) * this.arena.goalHalfWidth * wide;
    }
    let gx = bx - this.goalX; // unit vector (aim point in goal) -> ball
    let gy = by - aimY;
    const gd = Math.hypot(gx, gy) || 1;
    gx /= gd;
    gy /= gd;

    // behind the ball = driving through it sends it goalward. Skilled drivers
    // demand tighter alignment before committing (shots spray less) — except
    // when the ball threatens their own goal: then any touch is a clearance.
    const ownGoalX = -this.goalX;
    const danger =
      Math.abs(ball.x - ownGoalX) < 16 && Math.abs(ball.y) < this.arena.goalHalfWidth + 8;
    const commit = danger ? 0.1 : 0.62 - 0.12 * p.skill;
    const behind = dxb * -gx + dyb * -gy > distB * commit;

    // low-tempo drivers shadow: when the ball is in their defensive half and
    // not urgent, they hover goal-side on the shot line instead of charging
    const ballInAttackHalf = ball.x * Math.sign(this.goalX) > -5;
    const shadowDist = (1 - p.tempo) * 30;
    const shadowing = !danger && !ballInAttackHalf && distB > 12 && shadowDist > 5;

    let tx;
    let ty;
    if (shadowing) {
      tx = bx + gx * shadowDist;
      ty = by + gy * shadowDist;
    } else if (behind || distB < 5 || distB > 30) {
      // committed: aim at a point just behind the ball centre so the contact
      // normal lines up with the shot
      tx = bx + gx * 1.2;
      ty = by + gy * 1.2;
    } else {
      // swing around: approach point behind the ball, bowed to our own side
      // so we don't plough the ball toward our own goal on the way
      const side = Math.sign(gx * (car.y - by) - gy * (car.x - bx)) || 1;
      tx = bx + gx * p.approach - gy * side * 4.0;
      ty = by + gy * p.approach + gx * side * 4.0;
    }
    // keep targets inside the arena so wall-hugging balls don't lure us in;
    // if clamping collapsed the swing point onto the ball, just whack the ball
    tx = clamp(tx, -(this.arena.halfW - 2.5), this.arena.halfW - 2.5);
    ty = clamp(ty, -(this.arena.halfH - 2.5), this.arena.halfH - 2.5);
    if (Math.hypot(tx - bx, ty - by) < 3.5) {
      tx = bx;
      ty = by;
    }

    const alpha = wrapAngle(Math.atan2(ty - car.y, tx - car.x) - car.heading);
    const distT = Math.hypot(tx - car.x, ty - car.y);

    // steering with hysteresis (discrete keys need a deadband)
    if (this.steerState === 0) {
      if (alpha > p.steerOn) this.steerState = 1;
      else if (alpha < -p.steerOn) this.steerState = -1;
    } else if (this.steerState === 1 && alpha < p.steerOn * 0.4) {
      this.steerState = alpha < -p.steerOn ? -1 : 0;
    } else if (this.steerState === -1 && alpha > -p.steerOn * 0.4) {
      this.steerState = alpha > p.steerOn ? 1 : 0;
    }

    // reverse out when the target sits behind us and close (and there is room
    // to reverse); otherwise keep driving — forward U-turns beat parking
    const backUp = !rearBlocked && Math.abs(alpha) > 2.2 && distT < 16 && u < 8;
    // approach control: bleed speed into misaligned close-range ball work so
    // the fast car stops overshooting and looping back
    const hot = distB < 14 && Math.abs(alpha) > 0.5 && u > 20;
    // a shot is on: behind the ball, pointing at the (aim-adjusted) target
    const lined = behind && !shadowing && Math.abs(alpha) < 0.15;
    // herding: while pushing the ball around midfield, match its pace instead
    // of launching through it — sustained possession beats one big whack.
    // Near the goal (or on a clean look) release and shoot.
    const ballSpd = Math.hypot(ball.vx, ball.vy);
    const distGoal = Math.hypot(this.goalX - ball.x, ball.y);
    const herd = behind && !lined && distB < 10 && u > ballSpd + 9 && distGoal > 32;
    const W = !backUp && !hot && !herd && (Math.abs(alpha) < 1.35 || u < 12);
    const S = backUp || hot || (Math.abs(alpha) > 1.9 && u > 14);
    let A = this.steerState > 0;
    let D = this.steerState < 0;
    if (backUp && u < 0.5) {
      // reversing flips yaw response: swap steering so the nose comes around
      A = this.steerState < 0;
      D = this.steerState > 0;
    }

    // handbrake for sharp carves at speed (personality-gated)
    const Space = Math.abs(alpha) > 0.85 && u > 15 && rng.next() < p.driftiness * 0.6;

    // boost on lined-up shots — held boost at contact is the power shot —
    // and occasionally on long straight chases
    const LShiftKey =
      car.boost > 20 &&
      u > 6 &&
      W &&
      ((lined && (distB < 20 || rng.next() < p.boostiness)) ||
        (Math.abs(alpha) < 0.08 && distT > 34 && rng.next() < p.boostiness * 0.5));

    return keysFrom({ W, S, A, D, Space, LShiftKey });
  }
}

export class SoccerMode {
  constructor(spec) {
    this.spec = spec;
  }

  build(world) {
    const cfg = this.spec.soccer;
    const scale = cfg.pitchScale;
    const arena = buildArena(world.rng, {
      halfW: 55 * scale,
      halfH: 36 * scale,
      cornerR: 10,
      goalHalfWidth: 7 * scale,
    });
    world.space = arena;
    this.arena = arena;
    // ball passes the wall only through the mouth interior (posts stay solid)
    this.mouthHalf = arena.goalHalfWidth - 1.0;

    const params = carParamsFor(this.spec);
    this.kickoffPose = { x: -18, y: 0, heading: 0 };
    world.car = new Car(freeTrack(this.kickoffPose.x, this.kickoffPose.y, 0), 0, params);

    const botRng = world.rng.fork('soccer-bot');
    this.playerBrain = new BallChaser(
      botRng,
      arena.halfW,
      arena,
      personality(botRng, 0.85 + 0.1 * botRng.next()),
      this.spec.weapon.enabled,
    );

    // rivals: slightly slower cars, sloppier personalities — the player bot
    // should usually win, the rival sometimes
    this.opponents = [];
    const oppRng = world.rng.fork('soccer-opp');
    const n = cfg.opponents;
    for (let i = 0; i < n; i++) {
      const pose = { x: 18, y: n === 1 ? 0 : i === 0 ? -9 : 9, heading: Math.PI };
      const oParams = { ...params };
      const pace = 0.66 + 0.08 * oppRng.next();
      oParams.uMax *= pace;
      oParams.uMaxBoost *= pace;
      oParams.aEngine *= 0.9;
      const car = new Car(freeTrack(pose.x, pose.y, pose.heading), 0, oParams);
      const brain = new BallChaser(
        oppRng.fork(`opp${i}`),
        -arena.halfW,
        arena,
        personality(oppRng, 0.5 + 0.25 * oppRng.next()),
        false,
      );
      this.opponents.push({ car, brain, pose, keys: null });
    }
    this._rivalCars = this.opponents.map((o) => o.car);

    this.ball = { x: 0, y: 0, vx: 0, vy: 0, radius: BALL.radius };
    world.matchScore = { us: 0, them: 0 };
    this.lastGoal = { by: null, frame: -1000 }; // render drives the goal flash
    this.freezeSub = KICKOFF_FREEZE_FRAMES * SUBSTEPS; // opening countdown
    this._decideFrame = -1;

    // trackless-mode bookkeeping the recorder/meta surface expects
    world.lap = 0;
    world.progress = 0; // meters driven by the avatar
  }

  decide(world) {
    if (this.freezeSub > 0) {
      // kickoff countdown: the player brain is paused exactly like the rival
      // brains (theirs run in stepBodies, which no-ops while frozen) — no rng
      // draws, no stuck-counter wind-up from the forced standstill
      this.playerBrain.stuckFrames = 0;
      this.playerBrain.recoverFrames = 0;
      return keysFrom({});
    }
    return this.playerBrain.decide(world.car, this.ball, this._rivalCars);
  }

  // world.js gates weapons/damage/pickups on this, giving the kickoff freeze
  // the exact same semantics as the death freeze for everything the player
  // could otherwise do or suffer
  frozen() {
    return this.freezeSub > 0;
  }

  stepAvatar(world, keys, dt) {
    const car = world.car;
    if (this.freezeSub > 0) {
      // kickoff countdown: keys ignored, exactly like the respawn freeze
      car.wallImpact = 0;
      return null;
    }
    const q = car.step(keys, dt); // stub track: its wall branch never fires
    const impact = this._constrainCar(world, car);
    if (impact > car.wallImpact) car.wallImpact = impact; // WallHit events
    return q;
  }

  // Arena wall response for a car body. Inside a goal mouth (which the
  // renderer draws fully OPEN) the closed arena SDF is skipped — bouncing
  // there would teach the world model collisions with empty air — and a
  // back-of-net box takes over: side netting at the posts, back panel
  // NET_DEPTH past the line, so cars can drive into the mouth but never
  // leave the pitch. Mirrors the ball's mouth exemption, with a closed back.
  _constrainCar(world, car) {
    const a = this.arena;
    const r = car.p.radius;
    const rest = car.p.wallRestitution;
    const keep = car.p.wallTangentKeep;
    const inMouth = Math.abs(car.y) < this.mouthHalf && Math.abs(car.x) > a.halfW - 3;
    if (!inMouth) {
      return bounce(car, world.space.constrain(car.x, car.y, r), rest, keep);
    }
    let impact = 0;
    // side netting/posts: only past the wall line, where the skipped SDF
    // would otherwise let the car slide out of the mouth sideways
    if (Math.abs(car.x) > a.halfW - r && Math.abs(car.y) > this.mouthHalf - r) {
      const sy = car.y > 0 ? 1 : -1;
      impact = Math.max(
        impact,
        bounce(car, { x: car.x, y: sy * (this.mouthHalf - r), nx: 0, ny: -sy, hit: true }, rest, keep),
      );
    }
    // back of the net: NET_DEPTH behind the goal line ends the world
    if (Math.abs(car.x) > a.halfW + NET_DEPTH - r) {
      const sx = car.x > 0 ? 1 : -1;
      impact = Math.max(
        impact,
        bounce(car, { x: sx * (a.halfW + NET_DEPTH - r), y: car.y, nx: -sx, ny: 0, hit: true }, rest, keep),
      );
    }
    return impact;
  }

  // Mode bodies: rival cars, ball physics, wall/net bounces, goal checks.
  // Runs from postStep in live play AND directly from world.js during the
  // death freeze — a dead player must not stop the ball mid-flight or park
  // the rivals. keys === null marks the dead-avatar path: the frozen corpse
  // never kicks the ball and never trades car-vs-car bumps.
  stepBodies(world, dt, frameEvents, keys = null) {
    if (this.freezeSub > 0) {
      // kickoff countdown holds every body still (this is the single
      // per-substep decrement point for both the live and dead paths)
      this.freezeSub--;
      return;
    }
    const car = world.car;

    // rivals: decisions at 20 Hz (once per action frame), physics per substep
    if (this._decideFrame !== world.frame) {
      this._decideFrame = world.frame;
      for (const o of this.opponents) o.keys = o.brain.decide(o.car, this.ball, [car]);
    }
    for (const o of this.opponents) {
      o.car.step(o.keys || EMPTY_KEYS, dt);
      this._constrainCar(world, o.car);
    }

    // ball: exponential rolling friction, then integrate
    const ball = this.ball;
    const decay = Math.exp(-BALL.friction * dt);
    ball.vx *= decay;
    ball.vy *= decay;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // kicks in fixed order (player first) — the order is part of determinism
    if (keys !== null && this._kick(car, ball, !!keys.LShiftKey)) ball.lastTouch = 'us';
    for (const o of this.opponents) {
      if (this._kick(o.car, ball, !!(o.keys && o.keys.LShiftKey))) ball.lastTouch = 'them';
    }

    // arena walls, EXCEPT inside a goal mouth where the ball may cross
    const a = this.arena;
    const inMouth = Math.abs(ball.y) < this.mouthHalf && Math.abs(ball.x) > a.halfW - 3;
    if (!inMouth) {
      bounce(ball, a.constrain(ball.x, ball.y, BALL.radius), BALL.restitution, BALL.tangentKeep);
    }
    [ball.vx, ball.vy] = clampMag(ball.vx, ball.vy, BALL.vMax);

    // goal: ball centre across an end line inside the mouth
    if (Math.abs(ball.x) > a.halfW && Math.abs(ball.y) < a.goalHalfWidth) {
      const by = ball.x > 0 ? 'us' : 'them';
      world.matchScore[by]++;
      if (by === 'us') world.score += 100;
      this.lastGoal = { by, frame: world.frame };
      frameEvents.push({ name: 'GoalScored', data: { by, score: { ...world.matchScore } } });
      this._kickoffReset(world);
      return;
    }

    // car-vs-car bumping (equal mass, mild restitution)
    for (let i = 0; i < this.opponents.length; i++) {
      if (keys !== null) this._bump(car, this.opponents[i].car);
      for (let j = i + 1; j < this.opponents.length; j++) {
        this._bump(this.opponents[i].car, this.opponents[j].car);
      }
    }
  }

  postStep(world, keys, dt, frameEvents) {
    if (this.freezeSub <= 0) {
      world.progress += Math.hypot(world.car.vx, world.car.vy) * dt;
    }
    this.stepBodies(world, dt, frameEvents, keys);
  }

  _kick(car, ball, powerHeld) {
    const dx = ball.x - car.x;
    const dy = ball.y - car.y;
    const d = Math.hypot(dx, dy);
    const minD = BALL.radius + BALL.carContactR;
    if (d >= minD) return false;
    const nx = d > 1e-6 ? dx / d : Math.cos(car.heading);
    const ny = d > 1e-6 ? dy / d : Math.sin(car.heading);
    // hard separation so the ball never rides on the car's nose
    ball.x = car.x + nx * minD;
    ball.y = car.y + ny * minD;
    // kick direction: contact normal blended toward the car's direction of
    // travel — the nose carries the ball, so shots go where the driver aims
    let kx = nx;
    let ky = ny;
    const sp = Math.hypot(car.vx, car.vy);
    if (sp > 1) {
      kx = nx + (car.vx / sp) * 0.55;
      ky = ny + (car.vy / sp) * 0.55;
      const kl = Math.hypot(kx, ky) || 1;
      kx /= kl;
      ky /= kl;
    }
    const closing = (car.vx - ball.vx) * kx + (car.vy - ball.vy) * ky;
    if (closing > 0) {
      const power = BALL.kick * (powerHeld ? BALL.powerKick : 1);
      ball.vx += kx * closing * power;
      ball.vy += ky * closing * power;
    }
    return true;
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

  // stuck/recovery/burst state must not carry across the teleport — a brain
  // mid-recovery at the whistle would open the kickoff reversing at its own
  // goal (and the freeze itself must never wind the stuck counter up)
  _resetBrainTimers(brain) {
    brain.stuckFrames = 0;
    brain.recoverFrames = 0;
    brain.burstFrames = 0;
  }

  _kickoffReset(world) {
    const c = world.car;
    c.x = this.kickoffPose.x;
    c.y = this.kickoffPose.y;
    c.heading = this.kickoffPose.heading;
    c.vx = 0;
    c.vy = 0;
    c.steer = 0;
    c.u = 0;
    c.slip = 0;
    this._resetBrainTimers(this.playerBrain);
    for (const o of this.opponents) {
      o.car.x = o.pose.x;
      o.car.y = o.pose.y;
      o.car.heading = o.pose.heading;
      o.car.vx = 0;
      o.car.vy = 0;
      o.car.steer = 0;
      o.car.u = 0;
      o.car.slip = 0;
      o.keys = null;
      this._resetBrainTimers(o.brain);
    }
    this.ball.x = 0;
    this.ball.y = 0;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.freezeSub = KICKOFF_FREEZE_FRAMES * SUBSTEPS;
  }

  respawnPose() {
    return { ...this.kickoffPose };
  }

  // entity placement: uniform arena points with a wall margin; patrollers
  // sweep a random chord across the pitch. Soccer specs usually have no
  // monsters, but the engine allows them — this must not crash.
  placer(world) {
    const space = world.space;
    return {
      spawnMonster(rng) {
        const lair = space.randomPoint(rng, 6);
        const a = space.randomPoint(rng, 5);
        const b = space.randomPoint(rng, 5);
        if (Math.hypot(b.x - a.x, b.y - a.y) < 6) b.x = a.x + (a.x > 0 ? -10 : 10); // degenerate chord guard
        return { s: 0, lairX: lair.x, lairY: lair.y, px0: a.x, py0: a.y, px1: b.x, py1: b.y };
      },
      spawnPickup(rng) {
        return space.randomPoint(rng, 5);
      },
      // keep ambling monsters on the pitch (same hook as the other arenas)
      constrainMonster(m) {
        const r = space.constrain(m.x, m.y, m.cfg.size);
        m.x = r.x;
        m.y = r.y;
      },
    };
  }

  snapshot(world, snap) {
    const r = (v) => Math.round(v * 1000) / 1000;
    snap.soccer = {
      ball: [r(this.ball.x), r(this.ball.y)],
      ballVel: [r(this.ball.vx), r(this.ball.vy)],
      score: { ...world.matchScore },
      opponents: this.opponents.map((o) => [r(o.car.x), r(o.car.y), r(o.car.heading)]),
    };
  }
}
