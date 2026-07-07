# MIRA Racer — a Three.js game that trains a world model

This directory is step one of a larger plan: **games as dataset generators for
neural game engines**. A procedural Three.js racing game plays itself, records
`(frames, actions, state)` at 20 FPS, and emits datasets in the exact format the
MIRA pipeline (this repo) trains its latent-diffusion world model on. Once
trained, the world model *is* the game — rendered frame by frame from player
actions, no engine underneath.

```
seeded procedural racer (three.js)          MIRA training (this repo, GPU)
┌───────────────────────────────┐   pack    ┌──────────┐   ┌─────────────┐
│ sim 60Hz → bot keys → render  │ ────────► │  codec   │ → │ world model │
│ 512x288 @ 20fps, 6-key actions│  shards   │ (RAE)    │   │ (latent DiT)│
└───────────────────────────────┘           └──────────┘   └─────────────┘
        ▲ deterministic seeds                     play it: actions → frames
```

## Layout

- `src/sim/` — deterministic fixed-timestep sim, **no DOM/three.js deps**:
  seeded RNG, procedural circuits (Catmull-Rom on a jittered annulus, mirrored
  50% for turn balance), arcade drift physics (saturated-grip bicycle model),
  pure-pursuit bot with per-seed personality + exploration noise.
- `src/render/scene.js` — the visual layer, shared by game and recorder.
  Deliberate world-model affordances: per-vertex color noise everywhere
  (optical flow), 5 uniquely colored tower landmarks (relocalization), brake
  lights / steered wheels / boost flame (action observability).
- `src/game/` — playable build (`npm run dev`, then http://127.0.0.1:8712).
- `src/record/` — headless Chrome recorder (SwiftShader, no GPU needed).
- `pack/` — episodes → MIRA WebDataset shards + `index.json`, plus validation.
- `DATASET_CONTRACT.md` — the reverse-engineered MIRA dataset spec (authoritative).
- `TRAINING.md` — how to train codec + world model on RunPod from this data.

## Quickstart

```bash
npm install

npm test                       # sim determinism + bot competence across seeds
npm run dev                    # play it: WASD/arrows, Space handbrake, Shift boost,
                               #   B bot, N next track — http://127.0.0.1:8712/?seed=7

# generate a dataset (each episode = one procedural track, one bot personality)
node src/record/headless.js --episodes 100 --frames 2400 --seed0 1000 \
    --out episodes/run1 --concurrency 3

# pack into MIRA format (train/ + test/ splits with index.json + tar shards)
python3 pack/pack_dataset.py episodes/run1 --out dataset/v1

# validate against the actual mira.data loaders (see pack/README.md for env)
python3 pack/validate_mira.py dataset/v1/train
```

The 6-key action vocabulary (order is load-bearing, must match
`configs/actions/racing.yaml`): `W` throttle, `S` brake/reverse, `A`/`D` steer,
`Space` handbrake, `LShiftKey` boost.

## Dataset design choices (why the data looks like it does)

- **Bots emit keyboard actions, not continuous controls** — the world model
  learns `keys → next frame`, so the sim must be driven by the same discrete
  actions that get recorded.
- **Diversity is deliberate**: per-seed tracks, bot skill/aggression, racing
  line wander, random-action bursts, crashes and recoveries, warmup offsets.
  A model trained only on clean laps can't render what a wall feels like.
- **Determinism**: every episode is bit-exact replayable from its seed
  (`meta.json` records it), so datasets are reproducible and debuggable.

## Roadmap toward "any prompt becomes a game"

1. **Now**: one game (racing), one world model — validate the loop end to end.
2. Scale generation (it's CPU-only — any fleet of cheap cores works) and train
   on RunPod (see `TRAINING.md`).
3. Parameterize the generator into *families* (vehicle handling, camera, arena
   topology, art palette) → condition the world model on the family embedding.
4. Asset diversity via image models (e.g. FLUX on Replicate) for skyboxes,
   billboards, ground textures → the same sim geometry, endless looks.
5. New sim archetypes (arena/collect, pursuit, platformer-lite) sharing the
   recorder + contract — each is ~2 files of sim code. The end state: prompt →
   pick/blend archetype + generated assets → synthesize episodes → finetune →
   play inside the model.
