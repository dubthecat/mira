# lib/engine — EngineSource implementations

The play page drives an `EngineSource` (see `engineSource.js`):
`init(spec, seed) · stepFrame(keysOrNull) · getWorld() · dispose()`.

- **`localSim.js`** — `LocalSimEngine`, the deterministic Three.js sim from
  `../racer/src` (the dataset engine). Implemented, default.
- **`neuralStream.js`** — `NeuralStreamEngine`, the trained world model served
  by `racer/serve/serve_wm.py` over one WebSocket per session (protocol:
  `racer/serve/PROTOCOL.md`). Implemented and verified against the fake server
  (`node --test web/lib/engine/neuralStream.test.mjs`); needs a live endpoint
  to actually play.

## Wiring NeuralStreamEngine into PlayGame (the part that is NOT done yet)

`PlayGame.js` was deliberately left untouched (parallel work). At the
`ENGINE SWAP POINT` the differences to handle are:

```js
import { NeuralStreamEngine } from '../lib/engine/neuralStream.js';

const engine = new NeuralStreamEngine(process.env.NEXT_PUBLIC_NEURAL_WS_URL);
await engine.init(spec, seed);          // 1) ASYNC — opens ws + hello/ready handshake
```

1. `init` is **async** (LocalSimEngine's is sync). Await it (or `.then`) before
   starting the 20 Hz loop; it resolves with the server's `ready` info
   (`{ fps, keyOrder, width, height, mode }`) and rejects on refusal
   (`busy`) or connection failure.
2. `getWorld()` returns **null** — don't build the Three.js view. Draw streamed
   frames instead; the HUD is baked into the pixels:

```js
engine.onFrame((f) => {
  // f: { i, n, bytes: Uint8Array (JPEG), blobUrl, genMs, width, height }
  img.src = f.blobUrl;                  // simplest: <img> or canvas drawImage
  // f.blobUrl of the PREVIOUS frame is revoked when the next arrives —
  // draw/assign promptly, don't stash old URLs.
});
```

3. Keep the fixed 20 Hz loop exactly as for the local sim; each tick:
   `engine.stepFrame(botRef.current ? null : { ...held })`. It is non-blocking
   (send + return status); frames arrive via `onFrame`, at the server's pace —
   if the GPU is slower than real time you simply see fewer frames per second
   (no interpolation, no queue growth).
   Note there is no server-side bot: `null` keys mean "nothing held".
4. `stepFrame` returns `{ state, frames, inFlight, ... }` — show
   `state === 'reconnecting' | 'error'` in the overlay (`engine.lastError` has
   the reason). The engine reconnects ONCE on an unexpected drop, then stays
   in `'error'`.
5. `engine.reset()` (async, resolves on the fresh `ready`) re-primes the model
   — the neural analogue of restarting the episode. Seed is currently
   informational: every session primes from the pod's fixed context clip.
6. `dispose()` on unmount, as with the local sim (closes the socket, revokes
   the blob URL).

Endpoint: `NEXT_PUBLIC_NEURAL_WS_URL` (e.g. `ws://<pod-ip>:<mapped-port>`,
printed by `racer/serve/deploy_serve.py`). Remember an https page can't open
plain `ws://` (mixed content) — fine from local `next dev`, needs a TLS proxy
in production. The `ENGINE_SOURCES` registry entry for `neural` can flip
`available: true` once an endpoint is configured.
