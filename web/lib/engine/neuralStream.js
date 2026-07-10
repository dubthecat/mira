// NeuralStreamEngine — EngineSource backed by the trained latent diffusion
// world model. NOT YET AVAILABLE: the model is in its training loop.
//
// When it lands, this class implements the same interface as LocalSimEngine,
// but instead of stepping a local sim it drives a remote model server:
//
//   init(spec, seed)   opens a WebSocket to the inference server:
//                        -> { type: 'init', spec, seed }
//                        <- { type: 'ready', width: 512, height: 288 }
//   stepFrame(keys)    sends one action per 20 Hz tick:
//                        -> { type: 'act', keys: ['W','A'] }   (multi-hot)
//                        <- one binary frame message (JPEG now, H264 later),
//                           decoded into the canvas. The HUD arrives baked
//                           into the pixels — the model learned speed bars,
//                           health segments and the minimap as part of the
//                           image function. There is no engine underneath.
//   getWorld()         returns null — there is no local world state; the
//                      frame IS the state. The page renders streamed frames
//                      instead of running the Three.js view.
//
// Full protocol sketch in web/README.md.

export class NeuralStreamEngine {
  constructor() {
    throw new Error(
      'NeuralStreamEngine: not yet trained — the world model is still in its GPU training loop. Play the local sim (the dataset engine) meanwhile.',
    );
  }
}
