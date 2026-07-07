# MIRA Racer — a prompt-parameterized game engine that trains world models

**Prompt → GameSpec → playable Three.js game → training dataset → neural game.**
A procedural game engine plays itself, records `(frames, actions, state)` at
20 FPS — with a HUD bound to live engine variables baked into every frame — and
emits datasets in the exact format the MIRA pipeline (this repo) trains its
latent-diffusion world model on. Once trained, the world model *is* the game:
rendered frame by frame from player actions, no engine underneath, UI included.

```
 "night race with monsters and a shotgun"
        │ compile (deterministic, seeded)
        ▼
   GameSpec json ──► sim 60Hz (track/monsters/guns/pickups) ──► 512x288 @ 20fps
        │             bot keys → multi-hot actions              + spec-driven HUD
        │                                                            │ pack
        ▼                                                            ▼
   actions.yaml                                          MIRA shards + index.json
   (per-game vocab)                                      → codec → world model
```

## One command, prompt to dataset

```bash
node src/forge.js "desert race with 8 chasing monsters and a blaster, minimap" \
    --episodes 50 --frames 2400 --out runs/desert-blaster --pack --validate
```

Or play any prompt immediately: `npm run dev` then
`http://127.0.0.1:8712/?prompt=lava+drift+race+with+turrets+and+a+gun&bot=0`.

**GameSpec** (`src/spec/schema.js`) is the single source of truth: biome
(meadow/desert/snow/night/lava), monsters (chasers/patrollers/turrets with
counts/scales/colors), weapons (blaster/spread, F key auto-added to the action
vocab), vehicle handling multipliers, track scale/width, pickups, and which HUD
elements render (speed/boost/health/ammo/score/lap/minimap — every one a pure
read of engine state). `compileSpec(prompt, {seed, variety, overrides})` maps
keywords to spec fields, `--variety 0.5` seeds randomness into unspecified
dimensions, `--set key.path=value` overrides anything. (seed, spec) →
bit-identical episode, always.

## Layout

- `src/spec/` — GameSpec schema + the prompt→spec compiler.
- `src/sim/` — deterministic fixed-timestep sim, **no DOM/three.js deps**:
  seeded RNG, procedural circuits (Catmull-Rom on a jittered annulus, mirrored
  50% for turn balance, fold-free + clearance-checked), arcade drift physics
  (saturated-grip bicycle model, spec-scaled handling), monsters/projectiles/
  pickups (`entities.js`), weapons, health/score/respawn rules, pure-pursuit
  bot with per-seed personality + exploration noise + trigger discipline.
- `src/render/` — visual layer shared by game and recorder: biome-styled
  scene (`scene.js`) and the engine-variable-bound HUD overlay (`hud.js`).
  Deliberate world-model affordances: per-vertex color noise everywhere
  (optical flow), 5 uniquely colored tower landmarks (relocalization), brake
  lights / steered wheels / boost flame / muzzle-visible projectiles / HUD
  (action + state observability).
- `src/game/` — playable build (`npm run dev`, then http://127.0.0.1:8712).
- `src/record/` — headless Chrome recorder (SwiftShader, no GPU needed).
- `src/forge.js` — the prompt→dataset pipeline CLI.
- `pack/` — episodes → MIRA WebDataset shards + `index.json`, plus validation,
  HF upload, and RunPod smoke-train deploy tooling.
- `DATASET_CONTRACT.md` — the reverse-engineered MIRA dataset spec (authoritative).
- `TRAINING.md` — how to train codec + world model on RunPod from this data.

## Quickstart

```bash
npm install

# all test suites: sim, spec compiler, HUD, forge/packer
npm test && node test/spec_check.mjs && node test/hud_check.mjs && node test/forge_check.mjs

npm run dev                    # play: WASD drive, Space handbrake, Shift boost, F fire,
                               #   B bot, N next track — add ?prompt=... for any game

# prompt -> episodes -> packed + validated MIRA dataset, one command
node src/forge.js "snow race, wide track, patrolling beetles" \
    --episodes 24 --out runs/snow1 --pack --validate

# classic racing (no spec), manual steps:
node src/record/headless.js --episodes 100 --frames 2400 --seed0 1000 \
    --out episodes/run1 --concurrency 3
python3 pack/pack_dataset.py --episodes episodes/run1 --out dataset/v1
python3 pack/validate_mira.py dataset/v1/train
```

The action vocabulary is per-game and derived from the spec (base 6 driving
keys + `F` when armed); forge writes the matching `actions.yaml` next to each
dataset. Order is load-bearing — freeze it once training starts.

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

1. ~~One game (racing), dataset contract validated end to end.~~ **Done.**
2. ~~Prompt-parameterized engine: biomes, monsters, weapons, handling, HUD
   bound to engine variables, per-game action vocabularies.~~ **Done** (this
   directory). Each spec is a distinct game; datasets carry their spec.
3. Scale generation (CPU-only — any fleet of cheap cores works) and train
   per-spec world models on RunPod (see `TRAINING.md`); then mixed-spec
   training with the spec embedded as conditioning → one model, many games.
4. Asset diversity via image models (e.g. FLUX on Replicate) for skyboxes,
   billboards, ground textures → the same sim geometry, endless looks.
5. New sim archetypes (arena/collect, pursuit, platformer-lite) sharing the
   spec + recorder + contract — each is ~2 files of sim code. The end state:
   prompt → archetype + spec + generated assets → synthesize episodes →
   finetune → play inside the model, HUD and all.
