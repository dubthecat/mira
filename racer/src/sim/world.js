// World = mode (archetype) + avatar + entities + shared game rules, stepped
// at exactly 20 action frames per second (3 physics substeps of 1/60 s each).
// One stepFrame() call is one dataset frame: the keys applied during it are
// the action line recorded for the frame rendered *before* the step
// (contract: keys on line t produce frame t+1).
//
// Everything is a function of (seed, spec). The spec's archetype selects a
// mode (circuit racing, soccer, arena shooter, open-world adventure — see
// modes/) which owns space, avatar params, bot policy and objectives; the
// world owns what every archetype shares: weapons, monsters, pickups,
// health/damage/respawn, score, and the recorder-facing surface.

import { Rng } from './rng.js';
import { ACTION_KEYS } from './car.js';
import { EntitySystem } from './entities.js';
import { createMode } from './modes/index.js';
import { makeSpec, actionKeysFor, specHash, WEAPON_KINDS } from '../spec/schema.js';

export const FPS = 20;
export const SUBSTEPS = 3;
export const DT = 1 / (FPS * SUBSTEPS);

export { ACTION_KEYS };

export class World {
  constructor(seed, spec = null) {
    this.spec = spec || makeSpec();
    this.seed = seed >>> 0;
    this.actionKeys = actionKeysFor(this.spec);
    // the spec hash salts the seed so the same seed under different specs
    // yields different worlds
    this.rng = new Rng((this.seed ^ specHash(this.spec)) >>> 0);

    this.frame = 0;
    this.events = [];

    // mode builds the play space, avatar (world.car) and objective state
    this.mode = createMode(this.spec);
    this.mode.build(this);

    this.entities = new EntitySystem(this.spec, this.mode.placer(this), this.rng);

    // combat / survival state (world-owned; the avatar is just a body)
    this.health = this.spec.rules.healthMax;
    this.ammo = this.spec.weapon.enabled ? this.spec.weapon.ammoStart : 0;
    this.score = 0;
    this.invulnSub = 0; // substeps of post-hit invulnerability left
    this.respawnSub = 0; // substeps of death-freeze left
    this.fireCooldownSub = 0;
  }

  // Advance one 20 Hz action frame. keys=null lets the mode's bot drive.
  stepFrame(keys = null) {
    if (keys === null) {
      keys = this.mode.decide(this);
    }
    this.lastKeys = keys;
    const frameEvents = [];
    let maxImpact = 0;
    const rules = this.spec.rules;

    for (let s = 0; s < SUBSTEPS; s++) {
      if (this.invulnSub > 0) this.invulnSub--;
      if (this.fireCooldownSub > 0) this.fireCooldownSub--;

      // mode-declared control freeze (e.g. soccer kickoff): same semantics
      // as the death freeze for everything the player could otherwise do
      const modeFrozen = !!this.mode.frozen?.(this);
      // objective clocks that must advance even while the avatar is dead
      // (e.g. shooter wave scheduling)
      this.mode.tick?.(this, DT, frameEvents);

      if (this.respawnSub > 0) {
        // death freeze: world keeps ticking, avatar doesn't
        this.respawnSub--;
        if (this.respawnSub === 0) {
          const pose = this.mode.respawnPose(this);
          this.car.x = pose.x;
          this.car.y = pose.y;
          this.car.heading = pose.heading;
          this.car.vx = 0;
          this.car.vy = 0;
          this.car.steer = 0;
          if (this.track) this.car.hintIdx = this.track.nearest(pose.x, pose.y).idx;
          this.health = rules.healthMax;
          this.invulnSub = 40 * SUBSTEPS;
          frameEvents.push({ name: 'CarRespawned', data: {} });
        }
        // mode bodies (ball, rival cars) keep moving while the avatar is
        // dead — a dead player must not stop the world
        this.mode.stepBodies?.(this, DT, frameEvents);
      } else {
        this.mode.stepAvatar(this, keys, DT);
        maxImpact = Math.max(maxImpact, this.car.wallImpact);

        this.mode.postStep(this, keys, DT, frameEvents);

        // weapon (shared across archetypes)
        if (
          this.spec.weapon.enabled &&
          !modeFrozen &&
          keys.F &&
          this.fireCooldownSub <= 0 &&
          this.ammo >= WEAPON_KINDS[this.spec.weapon.kind].ammoPerShot
        ) {
          const w = WEAPON_KINDS[this.spec.weapon.kind];
          this.entities.fireFromCar(this.car);
          this.ammo -= w.ammoPerShot;
          this.fireCooldownSub = Math.round(FPS * SUBSTEPS / w.fireRate);
          frameEvents.push({ name: 'Fired', data: { ammo: this.ammo } });
        }
      }

      // entities tick even while the avatar is dead (world stays alive)
      const res = this.entities.step(this.car, this.frame, DT);
      for (const e of res.events) {
        if (e.name === 'MonsterKilled') this.score += rules.scorePerKill;
        frameEvents.push(e);
      }
      if (res.damageToCar > 0 && this.invulnSub <= 0 && this.respawnSub <= 0 && !modeFrozen) {
        this.health -= res.damageToCar;
        this.invulnSub = rules.contactInvulnFrames * SUBSTEPS;
        frameEvents.push({ name: 'CarDamaged', data: { health: Math.max(0, this.health) } });
        if (this.health <= 0) {
          this.health = 0;
          this.respawnSub = rules.respawnFrames * SUBSTEPS;
          frameEvents.push({ name: 'CarDestroyed', data: {} });
        }
      }

      // pickups (world knows the caps, entities know the positions)
      if (this.respawnSub <= 0 && !modeFrozen) {
        const nHealth = this.entities.tryCollect(this.car, 'health', this.health < rules.healthMax);
        if (nHealth > 0) {
          this.health = Math.min(rules.healthMax, this.health + 30 * nHealth);
          frameEvents.push({ name: 'HealthPickup', data: { health: this.health } });
        }
        if (this.spec.weapon.enabled) {
          const nAmmo = this.entities.tryCollect(this.car, 'ammo', this.ammo < this.spec.weapon.ammoMax);
          if (nAmmo > 0) {
            this.ammo = Math.min(this.spec.weapon.ammoMax, this.ammo + 8 * nAmmo);
            frameEvents.push({ name: 'AmmoPickup', data: { ammo: this.ammo } });
          }
        }
      }
    }

    if (maxImpact > 6) {
      frameEvents.push({ name: 'WallHit', data: { impact: Math.round(maxImpact * 10) / 10 } });
    }
    for (const e of frameEvents) {
      this.events.push({ frame: this.frame, ...e });
    }
    this.frame++;
    return { keys, frameEvents };
  }

  // Per-frame physics record (dataset physics.jsonl line): everything needed
  // to later derive rewards or debug, including live entity state.
  snapshot() {
    const c = this.car;
    const r = (v) => Math.round(v * 1000) / 1000;
    const snap = {
      car: {
        pos: [r(c.x), r(c.y)],
        vel: [r(c.vx), r(c.vy)],
        speed: r(Math.hypot(c.vx, c.vy)),
        heading: r(c.heading),
        steer: r(c.steer),
        slip: r(c.slip),
        boost: r(c.boost),
        boosting: c.boosting,
        drifting: c.drifting,
      },
    };
    this.mode.snapshot(this, snap);
    if (this.spec.entities.monsters.length > 0 || this.spec.weapon.enabled) {
      snap.combat = {
        health: this.health,
        ammo: this.ammo,
        score: this.score,
        dead: this.respawnSub > 0,
        monsters: this.entities.monsters.map((m) => ({
          id: m.id,
          type: m.type,
          pos: [r(m.x), r(m.y)],
          alive: m.alive,
          health: m.health,
        })),
        projectiles: this.entities.projectiles.filter((p) => p.alive).length,
      };
    }
    return snap;
  }

  keysToActionLine(keys) {
    return JSON.stringify({ keys: this.actionKeys.filter((k) => keys[k]) });
  }

  // legacy statics (6-key base vocabulary) kept for existing tests
  static keysToMultiHot(keys) {
    return ACTION_KEYS.map((k) => (keys[k] ? 1 : 0));
  }

  static keysToActionLine(keys) {
    return JSON.stringify({ keys: ACTION_KEYS.filter((k) => keys[k]) });
  }
}
