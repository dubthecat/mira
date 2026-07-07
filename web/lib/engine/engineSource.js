// EngineSource — the seam where the deterministic sim gets swapped for the
// trained neural world model.
//
// The play page never talks to `World` directly; it talks to an EngineSource:
//
//   interface EngineSource {
//     init(spec, seed)      // build (or connect to) a game instance
//     stepFrame(keysOrNull) // advance one 20 Hz action frame
//                           //   keys: {W,S,A,D,Space,LShiftKey,F} multi-hot
//                           //   null: let the bot drive
//     getWorld()            // live world state for the renderer + overlay
//     dispose()             // release everything
//   }
//
// Today: LocalSimEngine wraps the deterministic Three.js sim from
// ../racer/src — the exact engine that generates the training datasets.
//
// Soon: NeuralStreamEngine sends the same 7-key multi-hot action per tick
// over a WebSocket and receives frames rendered by the latent diffusion
// world model (HUD baked in — the model learned it as pixels). Same
// interface, no engine underneath. See web/README.md for the protocol.

export { LocalSimEngine } from './localSim.js';
export { NeuralStreamEngine } from './neuralStream.js';

export const ENGINE_SOURCES = [
  { id: 'local-sim', label: 'local sim', available: true },
  { id: 'neural', label: 'neural (training)', available: false },
];
