// Circuit mode: the original racing archetype. This file intentionally
// reproduces the pre-mode behavior exactly — same rng draw order, same
// physics — so (seed, spec) episodes recorded before the mode seam replay
// bit-identically for circuit specs.

import { buildTrack } from '../track.js';
import { Car, carParamsFor } from '../car.js';
import { BotDriver } from '../bot.js';

export class CircuitMode {
  constructor(spec) {
    this.spec = spec;
  }

  build(world) {
    world.track = buildTrack(world.rng, {
      radiusScale: this.spec.world.trackScale,
      widthScale: this.spec.world.widthScale,
      boostPads: this.spec.world.boostPads,
    });
    world.car = new Car(world.track, 6, carParamsFor(this.spec));
    this._bot = new BotDriver(world.track, world.rng, this.spec);
    world.lap = 0;
    world.progress = 0;
    world.lapStartFrame = 0;
    world.pads = world.track.pads.map((p) => ({ ...p, cooldown: 0 }));
    world.lastQ = world.track.nearest(world.car.x, world.car.y);
    world.prevS = world.lastQ.s;
  }

  decide(world) {
    return this._bot.decide(world.car, world.lastQ, world);
  }

  stepAvatar(world, keys, dt) {
    const q = world.car.step(keys, dt);
    world.lastQ = q;
    return q;
  }

  postStep(world, keys, dt, frameEvents) {
    const q = world.lastQ;
    // lap progress: accumulate wrapped delta-s
    let dS = q.s - world.prevS;
    const L = world.track.length;
    if (dS < -L / 2) dS += L;
    if (dS > L / 2) dS -= L;
    world.progress += dS;
    world.prevS = q.s;
    const lapNow = Math.floor(world.progress / L);
    if (lapNow > world.lap) {
      world.lap = lapNow;
      frameEvents.push({
        name: 'LapCompleted',
        data: { lap: world.lap, lapFrames: world.frame - world.lapStartFrame },
      });
      world.lapStartFrame = world.frame;
    }

    // boost pads
    for (const pad of world.pads) {
      if (pad.cooldown > 0) {
        pad.cooldown = Math.max(0, pad.cooldown - dt);
        continue;
      }
      const dx = world.car.x - pad.x;
      const dy = world.car.y - pad.y;
      if (dx * dx + dy * dy < 2.2 * 2.2) {
        pad.cooldown = 4;
        world.car.boost = Math.min(100, world.car.boost + 30);
        frameEvents.push({ name: 'BoostPickup', data: { s: pad.s } });
      }
    }
  }

  respawnPose(world) {
    const q = world.track.sampleAt(world.lastQ.s);
    return { x: q.x, y: q.y, heading: q.theta };
  }

  // entity placement: track-relative, byte-compatible with the pre-mode code
  placer(world) {
    const t = world.track;
    return {
      spawnMonster(rng, type) {
        const s = rng.range(0.08, 0.98) * t.length;
        const q = t.sampleAt(s);
        const nx = -Math.sin(q.theta);
        const ny = Math.cos(q.theta);
        let lat;
        if (type === 'patroller') lat = 0;
        else if (type === 'turret') lat = (rng.bool() ? 1 : -1) * (q.halfWidth + rng.range(4, 10));
        else lat = (rng.bool() ? 1 : -1) * (q.halfWidth + rng.range(6, 22));
        return {
          s,
          lairX: q.x + nx * lat,
          lairY: q.y + ny * lat,
          px0: q.x + nx * (q.halfWidth - 1.5),
          py0: q.y + ny * (q.halfWidth - 1.5),
          px1: q.x - nx * (q.halfWidth - 1.5),
          py1: q.y - ny * (q.halfWidth - 1.5),
        };
      },
      spawnPickup(rng) {
        const s = rng.range(0.05, 0.95) * t.length;
        const q = t.sampleAt(s);
        const lat = rng.range(-1, 1) * Math.max(0, q.halfWidth - 3);
        return { x: q.x - Math.sin(q.theta) * lat, y: q.y + Math.cos(q.theta) * lat };
      },
      // chasers hover-track the wall line (visual); q lookup with hint
      wallGap(m) {
        const q = t.nearest(m.x, m.y, m.hintIdx);
        m.hintIdx = q.idx;
        return Math.abs(Math.abs(q.lateral) - q.halfWidth);
      },
    };
  }

  snapshot(world, snap) {
    const q = world.lastQ;
    const r = (v) => Math.round(v * 1000) / 1000;
    snap.track = {
      s: r(q.s),
      lateral: r(q.lateral),
      lap: world.lap,
      progress: r(world.progress),
    };
  }
}
