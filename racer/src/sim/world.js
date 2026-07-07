// World = track + car + bot + entities + game rules, stepped at exactly 20
// action frames per second (3 physics substeps of 1/60 s each). One
// stepFrame() call is one dataset frame: the keys applied during it are the
// action line recorded for the frame rendered *before* the step (contract:
// keys on line t produce frame t+1).
//
// Everything is a function of (seed, spec): the GameSpec (see spec/schema.js)
// selects biome, monsters, weapons, handling and HUD; the seed selects the
// concrete track/personality/spawn rolls within that game.

import { Rng } from './rng.js';
import { buildTrack } from './track.js';
import { Car, carParamsFor, ACTION_KEYS } from './car.js';
import { BotDriver } from './bot.js';
import { EntitySystem } from './entities.js';
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
    this.track = buildTrack(this.rng, {
      radiusScale: this.spec.world.trackScale,
      widthScale: this.spec.world.widthScale,
      boostPads: this.spec.world.boostPads,
    });
    this.car = new Car(this.track, 6, carParamsFor(this.spec));
    this.bot = new BotDriver(this.track, this.rng, this.spec);
    this.entities = new EntitySystem(this.spec, this.track, this.rng);

    this.frame = 0;
    this.lap = 0;
    this.progress = 0;
    this.lapStartFrame = 0;
    this.pads = this.track.pads.map((p) => ({ ...p, cooldown: 0 }));
    this.lastQ = this.track.nearest(this.car.x, this.car.y);
    this.prevS = this.lastQ.s;
    this.events = [];

    // combat / survival state (world-owned; the car is just a body)
    this.health = this.spec.rules.healthMax;
    this.ammo = this.spec.weapon.enabled ? this.spec.weapon.ammoStart : 0;
    this.score = 0;
    this.invulnSub = 0; // substeps of post-hit invulnerability left
    this.respawnSub = 0; // substeps of death-freeze left
    this.fireCooldownSub = 0;
  }

  // Advance one 20 Hz action frame. keys=null lets the bot drive.
  stepFrame(keys = null) {
    if (keys === null) {
      keys = this.bot.decide(this.car, this.lastQ, this);
    }
    this.lastKeys = keys;
    const frameEvents = [];
    let maxImpact = 0;
    const rules = this.spec.rules;

    for (let s = 0; s < SUBSTEPS; s++) {
      if (this.invulnSub > 0) this.invulnSub--;
      if (this.fireCooldownSub > 0) this.fireCooldownSub--;

      if (this.respawnSub > 0) {
        // death freeze: world keeps ticking, car doesn't
        this.respawnSub--;
        if (this.respawnSub === 0) {
          const q = this.track.sampleAt(this.lastQ.s);
          this.car.x = q.x;
          this.car.y = q.y;
          this.car.heading = q.theta;
          this.car.vx = 0;
          this.car.vy = 0;
          this.car.steer = 0;
          this.car.hintIdx = this.track.nearest(q.x, q.y).idx;
          this.health = rules.healthMax;
          this.invulnSub = 40 * SUBSTEPS;
          frameEvents.push({ name: 'CarRespawned', data: {} });
        }
      } else {
        const q = this.car.step(keys, DT);
        this.lastQ = q;
        maxImpact = Math.max(maxImpact, this.car.wallImpact);

        // lap progress: accumulate wrapped delta-s
        let dS = q.s - this.prevS;
        const L = this.track.length;
        if (dS < -L / 2) dS += L;
        if (dS > L / 2) dS -= L;
        this.progress += dS;
        this.prevS = q.s;
        const lapNow = Math.floor(this.progress / L);
        if (lapNow > this.lap) {
          this.lap = lapNow;
          frameEvents.push({
            name: 'LapCompleted',
            data: { lap: this.lap, lapFrames: this.frame - this.lapStartFrame },
          });
          this.lapStartFrame = this.frame;
        }

        // boost pads
        for (const pad of this.pads) {
          if (pad.cooldown > 0) {
            pad.cooldown = Math.max(0, pad.cooldown - DT);
            continue;
          }
          const dx = this.car.x - pad.x;
          const dy = this.car.y - pad.y;
          if (dx * dx + dy * dy < 2.2 * 2.2) {
            pad.cooldown = 4;
            this.car.boost = Math.min(100, this.car.boost + 30);
            frameEvents.push({ name: 'BoostPickup', data: { s: pad.s } });
          }
        }

        // weapon
        if (
          this.spec.weapon.enabled &&
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

      // entities tick even while the car is dead (world stays alive)
      const res = this.entities.step(this.car, this.frame, DT);
      for (const e of res.events) {
        if (e.name === 'MonsterKilled') this.score += rules.scorePerKill;
        frameEvents.push(e);
      }
      if (res.damageToCar > 0 && this.invulnSub <= 0 && this.respawnSub <= 0) {
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
      if (this.respawnSub <= 0) {
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
    const q = this.lastQ;
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
      track: {
        s: r(q.s),
        lateral: r(q.lateral),
        lap: this.lap,
        progress: r(this.progress),
      },
    };
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
