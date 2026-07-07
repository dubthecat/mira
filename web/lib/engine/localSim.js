// LocalSimEngine — EngineSource backed by the deterministic sim in
// ../racer/src. This is the same engine that generates the training
// datasets: (seed, spec) -> bit-identical episodes, stepped at exactly
// 20 action frames per second.
//
// The engine sources are imported straight out of the racer package via
// relative paths; they are plain ESM with no DOM dependencies (the sim is
// deliberately DOM-free — only the renderer in ../racer/src/render touches
// the browser).

import { World } from '../../../racer/src/sim/world.js';

export class LocalSimEngine {
  constructor() {
    this.world = null;
  }

  init(spec, seed) {
    this.world = new World(seed >>> 0, spec);
  }

  // Advance one 20 Hz action frame. keys is the 7-key multi-hot object
  // ({W,S,A,D,Space,LShiftKey,F} -> bool); null lets the built-in bot drive.
  stepFrame(keysOrNull) {
    return this.world.stepFrame(keysOrNull);
  }

  getWorld() {
    return this.world;
  }

  dispose() {
    // the sim holds no GPU or DOM resources; drop the reference
    this.world = null;
  }
}
