# PredictExpert Game Engine — web (public face + online play surface)

A Next.js (App Router, plain JS) site for the PredictExpert Game Engine:

- `/` — landing page. One prompt box ("Build a game"), the pipeline diagram
  (prompt → GameSpec → procedural game → dataset → RAE codec → diffusion world
  model → playable neural game), the interactive-loop diagram, and engine stats.
- `/play?prompt=...` — compiles the prompt into a GameSpec with the racer
  engine's own compiler and runs the game full-viewport at a fixed 20 Hz sim
  step, with the engine's HUD baked into the frame — exactly like the training
  datasets. Optional params: `&seed=<n>`, `&bot=1`.

## Run

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build (webpack — see next.config.mjs)
```

## How the engine import works

The game engine lives outside this app in `../racer/src` (plain ESM, no build
step). Web code imports it via relative paths, e.g.
`import { World } from '../../racer/src/sim/world.js'`. Two pieces of config
make that work for both `next dev` and `next build`:

- `outputFileTracingRoot` points at the repo root so Next traces files above
  `web/`.
- a webpack alias pins `three` to `web/node_modules/three`, so the engine's
  bare `import 'three'` and the app resolve one shared copy (racer has its own
  `node_modules/three`; without the alias the bundle would carry two).

Scripts run webpack (no `--turbopack`), which handles outside-the-root imports
without fuss.

## Today / soon: the EngineSource seam

The play page never talks to the sim directly — it drives an `EngineSource`
(`lib/engine/engineSource.js`):

```
init(spec, seed) · stepFrame(keysOrNull) · getWorld() · dispose()
```

- **`LocalSimEngine`** (implemented) wraps the deterministic sim from
  `../racer/src` — the same engine that generates the training data.
  `(seed, spec)` → bit-identical episodes at 20 fps.
- **`NeuralStreamEngine`** (stub — constructor throws `not yet trained`) will
  drive the trained latent-diffusion world model over a WebSocket. Same
  interface, same loop; the swap is one line in
  `components/PlayGame.js` (marked `ENGINE SWAP POINT`).

### NeuralStreamEngine protocol sketch

One WebSocket per game session; the client is the clock (one action per 20 Hz
tick), the server renders frame-by-frame from the world model:

```
client -> server   { type: 'init', spec: <GameSpec json>, seed: 7 }
server -> client   { type: 'ready', width: 512, height: 288, codec: 'jpeg' }

# then, 20 times per second:
client -> server   { type: 'act', keys: ['W', 'A'] }        # 7-key multi-hot,
                                                            # same vocabulary as
                                                            # actions.yaml
server -> client   <binary frame>                           # JPEG per frame now;
                                                            # H264 chunks later

client -> server   { type: 'reset', seed: 8 }               # new episode
```

Notes:

- The action vocabulary is per-game and derived from the spec (6 driving keys
  + `F` when armed) — identical to the dataset's `actions.yaml`. Order is
  load-bearing.
- Frames arrive with the HUD baked in: the model learned speed bars, health
  segments and the minimap as part of the image function. There is no engine
  underneath — `getWorld()` returns `null` and the page draws the streamed
  frames instead of running the Three.js view.
- Backpressure: the client skips `act` messages while more than 2 frames are
  in flight, so latency degrades to a lower effective fps instead of a
  growing queue.

## Layout

```
app/
  layout.js            fonts (next/font: Inter + JetBrains Mono) + globals
  globals.css          design tokens (dark only) + all styling, plain CSS
  page.js              landing
  play/page.js         client-only game page (dynamic import, ssr: false)
components/
  PromptHero.js        the hero prompt box -> /play?prompt=
  PipelineDiagram.js   inline-SVG pipeline with runs-now / training-loop split
  LoopDiagram.js       inline-SVG circular interactive loop
  EngineStats.js       stat tiles + frames-per-dataset bar row
  PlayGame.js          the game: fixed-timestep loop ported from
                       racer/src/game/main.js, full cleanup on unmount
lib/engine/
  engineSource.js      the EngineSource interface + registry
  localSim.js          LocalSimEngine (implemented, wraps racer's World)
  neuralStream.js      NeuralStreamEngine (stub: throws 'not yet trained')
```

## Deploying on Vercel

The app is fully static + client-side (no API routes, no server secrets) —
**no environment variables are required**.

Project settings (dashboard → Import `dubthecat/mira`):

| setting | value |
|---|---|
| Root Directory | `web` |
| "Include source files outside of the Root Directory" | **enabled** (the build imports `../racer/src`) |
| Framework preset | Next.js (auto-detected) |
| Production branch | `racer-pipeline` (until merged to `main`) |
| Environment variables | none |

Never add the pipeline secrets (HF/RunPod/Replicate keys) to Vercel — the
site doesn't use them, and anything prefixed `NEXT_PUBLIC_` ships to every
visitor's browser.

Future env (when the neural engine goes live): `NEXT_PUBLIC_NEURAL_WS_URL` —
the WebSocket endpoint of the GPU inference server that NeuralStreamEngine
connects to (see `lib/engine/neuralStream.js`).
