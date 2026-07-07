// World = track + car + bot + game rules, stepped at exactly 20 action frames
// per second (3 physics substeps of 1/60 s each). One stepFrame() call is one
// dataset frame: the keys applied during it are the action line recorded for
// the frame rendered *before* the step (contract: keys on line t produce
// frame t+1).

import { Rng } from './rng.js';
import { buildTrack } from './track.js';
import { Car, ACTION_KEYS } from './car.js';
import { BotDriver } from './bot.js';

export const FPS = 20;
export const SUBSTEPS = 3;
export const DT = 1 / (FPS * SUBSTEPS);

export { ACTION_KEYS };

export class World {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.track = buildTrack(this.rng);
    this.car = new Car(this.track);
    this.bot = new BotDriver(this.track, this.rng);
    this.frame = 0;
    this.lap = 0;
    this.progress = 0; // cumulative signed arc-length progress (m)
    this.lapStartFrame = 0;
    this.pads = this.track.pads.map((p) => ({ ...p, cooldown: 0 }));
    this.lastQ = this.track.nearest(this.car.x, this.car.y);
    this.prevS = this.lastQ.s;
    this.events = []; // {frame, name, data} accumulated for the whole episode
  }

  // Advance one 20 Hz action frame. keys=null lets the bot drive.
  // Returns {keys, frameEvents} — keys is the plain 6-key boolean object that
  // was actually applied (i.e. what must be recorded for this action line).
  stepFrame(keys = null) {
    if (keys === null) {
      keys = this.bot.decide(this.car, this.lastQ);
    }
    this.lastKeys = keys;
    const frameEvents = [];
    let maxImpact = 0;

    for (let s = 0; s < SUBSTEPS; s++) {
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
          data: {
            lap: this.lap,
            lapFrames: this.frame - this.lapStartFrame,
          },
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

  // Per-frame physics record (dataset physics.jsonl line). Compact but enough
  // to later derive rewards (progress, lap times, wall contact) or debug.
  snapshot() {
    const c = this.car;
    const q = this.lastQ;
    const r = (v) => Math.round(v * 1000) / 1000;
    return {
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
  }

  // multi-hot int array in ACTION_KEYS order (for tests/telemetry)
  static keysToMultiHot(keys) {
    return ACTION_KEYS.map((k) => (keys[k] ? 1 : 0));
  }

  // keys object -> dataset action line (contract §1.5)
  static keysToActionLine(keys) {
    return JSON.stringify({ keys: ACTION_KEYS.filter((k) => keys[k]) });
  }
}
