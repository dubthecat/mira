# MIRA Dataset Contract — Spec for a Three.js Racing-Game Recorder (n_players=1)

Authoritative spec for emitting a dataset that `mira.data.RocketScienceDataset` / `create_loader` can train the codec and world model on. All facts below were verified against the code at `/home/engli/new/mira` (file:line references are to that repo). The container format is game-agnostic; only names/semantics are Rocket-League-flavored.

---

## 1. Exact on-disk layout

### 1.1 Directory layout

One directory per split, passed as `dataset.train_index` / `dataset.test_index` (either the directory or its `index.json` — `RocketScienceDataset.from_local`, `src/mira/data/dataset.py:166-173`). There is **no random split in code**; train/test = separate directories.

```
train/
  index.json                 # single JSON object (NOT jsonl)
  dataset_00000.tar          # WebDataset shards, flat...
  dataset_00001.tar
  # ...or nested: 000/dataset_00000.tar (any relative path recorded in entry.shard works)
test/
  index.json
  dataset_00000.tar
```

- `MatchEntry.shard` is the shard path **relative to index.json's directory**; the loader opens `index_dir / entry.shard` (`dataset.py:152-153, 504, 615`). Shard filenames are unconstrained; `dataset_*.tar` is the convention.
- Streaming iterates shards in `sorted(str)` order (`dataset.py:538`).
- For HuggingFace Hub hosting, place each split under a top-level prefix equal to the split name (`train/index.json` + shards); `from_hub(repo, split="train")` downloads `train/*` (`dataset.py:176-228`).

### 1.2 `index.json` (schema: `src/mira/data/schema.py`)

Single JSON object validated by pydantic `Index` (all models `extra="allow"`, so extra metadata fields are fine):

```json
{
  "total_samples": <int>,        // = len(entries) = number of matches (recordings)
  "entries": [ <MatchEntry>, ... ]
}
```

`MatchEntry` (one per recording/"match"):

| field | type | rules |
|---|---|---|
| `match_id` | str | **Must not contain `.`** (`chunk_key` raises, `dataset.py:69-70`). Must survive `rpartition("_c")` round-trip — practically: avoid a trailing `_c<digits>` in the id itself. Convention: `2026-07-07T12-00-00Z-<hash>`. |
| `shard` | str | Relative path of the single tar holding **all** of this match's chunk samples. |
| `n_players` | int | Number of perspectives. **Racing: `1`.** |
| `chunk_frames` | list[int] | Frame count of each present chunk, in order. |
| `chunk_indices` | list[int] \| null | Only if chunks are non-contiguous: the ORIGINAL source index of each present chunk; same length as `chunk_frames`, all distinct (validated at parse, `schema.py:61-75`). Omit for contiguous 0..N-1. |
| `arena` | str \| null | Optional free-form (e.g. track name). |
| `perspectives` | list[Perspective] | One per player; re-sorted by `player_id` at load to define the `p0..p{n-1}` axis (`dataset.py:161`). |

`Perspective`:

| field | type | rules |
|---|---|---|
| `player_id` | int | Any int; sort order defines which perspective is `p0`. |
| `team` | int | Required by schema; meaningless for racing — use `0`. |
| `frames` | int | **Must equal `sum(chunk_frames)` exactly** or the match raises/is skipped (`dataset.py:271-277`). |
| `duration` | float | Seconds. **Source fps is DERIVED as `sum(chunk_frames) / perspectives[0].duration`** (`dataset.py:278`) — set `duration = total_frames / fps` exactly. |
| `recording_offset_sec` | float | Default 0.0. Single-perspective racing: `0.0`. |
| `anchors` | list[Anchor] | Default `[]`. Optional (see §1.6). |

### 1.3 Shard format (WebDataset tar)

One WebDataset sample = one **(match, chunk)**. Sample key:

```
{match_id}_c{original_chunk_idx:05d}        # chunk_key(), dataset.py:63-71
```

Tar members per sample, for each perspective `i` in `0..n_players-1` (racing: only `p0`):

| member | required | content |
|---|---|---|
| `{key}.p{i}.mp4` | **yes** | Video bytes for the chunk, exactly `chunk_frames[c]` frames. |
| `{key}.p{i}.jsonl` | **yes** | Actions, exactly `chunk_frames[c]` lines, one per frame. |
| `{key}.p{i}.physics.jsonl` | no | Game state, one JSON object per frame (viz/debug only). |
| `{key}.meta.json` | no | **Never read by any code path** (`dataset.py:624-626` skips non-`p{i}` fields; `_read_chunk` never requests it). Safe to omit. |

Hard packing rules:
- **All members of one sample must be contiguous in the tar** — the streaming reader (`tarfile.open(path, "r|*")`) emits a sample on key change (`dataset.py:613-634`).
- Members are resolved by **basename**; a path prefix inside the tar is tolerated but basenames must be unique shard-wide (random access builds a shard-wide basename map, `dataset.py:452`).
- The WebDataset key is everything before the **first `.`** in the basename — hence no dots in `match_id`.
- All chunks of a match live in one tar; a tar may hold many matches. Write with stdlib `tarfile` (`TarInfo` + `addfile`), uncompressed `"w"` mode (random access opens with plain `"r"`; only streaming tolerates compression — ship uncompressed).

### 1.4 Video encoding

- Decoded exclusively via **torchcodec** `VideoDecoder(bytes).get_frames_at(frame_indices)` -> `(T, C, H, W)` uint8 (`src/mira/data/decode.py`). No PyAV/cv2/decord fallback. Pinned stack: torch 2.8, torchcodec 0.7.0, FFmpeg 7.
- Safe recipe (what the tests use, `tests/data/test_loader.py:26-32`): **H.264 (libx264), `yuv420p`, mp4 container, constant fps**. Even width/height required by libx264.
- Frame count per chunk mp4 must equal `chunk_frames[c]` exactly (decoded count checked against clip_len, `dataset.py:407-410`; indices go up to `chunk_frames[c]-1`).
- Frame-accurate random index access is needed — use a short GOP (e.g. `-g 20`) or all-intra for decode speed; any torchcodec-decodable encode is *correct* regardless.
- Resolution is free (no assertion anywhere); see §4 for the recommendation.

### 1.5 Actions (`{key}.p{i}.jsonl`)

- Exactly one JSON line per video frame of the chunk. Each line:

```json
{"keys": ["W", "Space"]}
```

- Semantics: the set of keys **held during** that frame (state, not key-down events). Convention consumed by the world model: keys on line `t` are the control that produces frame `t+1`.
- A blank line, absent `keys`, or `"keys": null` all mean "no keys held this frame" and still count as a frame (`actions.py:92-97`).
- Key strings are **case-sensitive exact matches** against the configured vocabulary; unknown keys are dropped with a once-per-key warning by default (`KeyVocab.on_unknown`, `actions.py:41-63`).
- Tensorized to `(T, n_keys)` **int32 0/1 multi-hot**, keys OR-ed over each integer downsample window (`tensorize_actions`, `actions.py:66-119`).
- **Keyboard-only.** There is no analog/mouse data path on disk: the training loader synthesizes `mouse_movements` as zeros `(B,T,2)` float32 and `game_mouse_sensitivity` as NaN `(B,)` float32 (`training_loader.py:122-127`). Analog steering/throttle must be quantized to keys (see §6 if you want true analog).

### 1.6 Physics and events (both optional)

- **Physics** (`{key}.p{i}.physics.jsonl`): one JSON object per frame. **Never read by training** — only `json.loads` per selected line for `MatchClip.physics` (`dataset.py:412-414`), consumed by viz/consistency tooling. The RL `FrameState` schema (`src/mira/data/state.py`: `game`/`ball`/`cars`) is documentation-only TypedDicts with no runtime validation, so a racing game may store arbitrary per-frame JSON (e.g. `{"car": {"pos": [x,y,z], "speed": v}, "lap": 1}`) or omit physics entirely. If present, it must exist for **all** perspectives of a chunk to be surfaced (`dataset.py:413`) and have one line per frame.
- **Events/anchors**: `{"event_type": int, "event_name": str, "master_sec": float}` on a match-wide clock, duplicated identically into every perspective (only `perspectives[0].anchors` is parsed, `dataset.py:305`). Frame mapping: `round((master_sec - recording_offset_sec) * fps)` (`events.py:31-33`). Only two names have loader semantics: `"GoalReplayStarted"` / `"GoalReplayEnded"` (`events.py:21-22`) drive `exclude_replays`. Everything else is informational (viz badges). **Racing: emit `anchors: []` and keep `exclude_replays: false`** — validation loaders that set `exclude_replays=True` still work with empty anchors (no-op). Optionally reuse the replay-pair names for any non-gameplay segments (menus, countdown, crash cinematics) you want auto-excluded.

---

## 2. Required vs optional

**Minimal REQUIRED set for training** (codec + world model):

1. `index.json` with `total_samples`, and per entry: `match_id`, `shard`, `n_players`, `chunk_frames`, `perspectives[{player_id, team, frames, duration}]`.
2. Per (match, chunk) tar sample: `{key}.p{i}.mp4` + `{key}.p{i}.jsonl` for every `i` in `0..n_players-1`, contiguous in the tar, exact frame/line counts.
3. Invariants: `frames == sum(chunk_frames)`; derived fps ≈ integer multiple of target fps (±0.5, `clips.py:22-33`); every clip fits one chunk: `(clip_len-1)*stride+1 <= max(chunk_frames)`; at least one match must fit the largest `clip_len` or `create_loader` raises at startup (`training_loader.py:296-307`).

**OPTIONAL** (safe to omit): `chunk_indices` (only for gaps), `arena`, `recording_offset_sec` (defaults 0.0), `anchors` (defaults `[]`), `{key}.p{i}.physics.jsonl`, `{key}.meta.json`, any extra JSON fields anywhere (e.g. `content_id`, lap times, track id — `extra="allow"` everywhere).

**Not consumed by training at all**: physics, events (except `exclude_replays`), `meta.json`, `arena`, `team` values, mouse tensors.

---

## 3. Configuration for a racing action space, n_players=1

### 3.1 New actions yaml — `configs/actions/racing.yaml`

`n_keys = len(valid_keys)` is fully configurable; the encoder auto-sizes (`ActionEncoder(num_key_presses=len(config.actions.valid_keys), ...)`, `src/mira/world_model/latent_world_model.py:113-122`; per-key `nn.Embedding(2, ...)` width derived at `action_encoder.py:61-62`). Example 6-key racing vocab:

```yaml
# configs/actions/racing.yaml
target_fps: 20          # action sample rate; 20 = one action per video frame
valid_keys:             # ORDER IS LOAD-BEARING: defines multi-hot columns and checkpoint layout
  - W                   # throttle
  - S                   # brake / reverse
  - A                   # steer left
  - D                   # steer right
  - Space               # handbrake
  - LShiftKey           # boost / nitro
```

Freeze this list and its order before training: the per-key embeddings are keyed `"0".."n-1"` and `n_keys` must match any checkpoint (`actions_config.py:26-30` docstring). Use exactly these strings in the recorder's `.jsonl`. In-browser key capture (`KeyboardEvent.code` gives `"KeyW"`, `"ShiftLeft"`, etc.) must be mapped to whatever names you choose — the names are free, only jsonl↔yaml consistency matters.

### 3.2 New dataset yaml — `configs/dataset/racing.yaml`

```yaml
defaults:
  - /actions@actions: racing
  - _self_

train_index: null       # override: dataset.train_index=/path/to/train
test_index: null
n_players: 1            # single perspective per match — fully supported end to end
target_fps: 20          # trainers override from model config anyway (video.fps = 20)
frame_size: null        # or [288, 512] to resize at decode (see §4)
exclude_replays: false
```

Then run trainers with `dataset=racing`. `train_world_model.py:356-360` enforces `dataset.n_players == getattr(model, "n_players", 1)` — the plain `LatentWorldModel` has no `n_players` attr, so `n_players: 1` is correct; do NOT use `multi_wrapper_world_model`.

### 3.3 Programmatic loading (no Hydra)

```python
loader = create_loader(index_path, clip_len=40, target_fps=20, n_players=1,
                       valid_keys=["W","S","A","D","Space","LShiftKey"], source_fps=20)
```

`valid_keys=None` silently falls back to the 9 RL keys (`training_loader.py:290`) — always pass yours. Same for `RocketScienceDataset(index_path, vocab=KeyVocab(("W",...)))` (`dataset.py:154`).

### 3.4 What NOT to touch

Codec/world-model derived quantities (latent_dim 32, temporal_downsampling 2, latent_mean_std) come from the codec checkpoint, not config. `action_temporal_downsampling = actions.target_fps * codec_td // video.fps = 20*2//20 = 2` is derived. Per-player action dropout (`dropout_action_per_player`) is a multiplayer feature; leave it off (default false for `LatentWorldModel`) — its `DEFAULT_SUBSET_KEYS` are RL names (§6).

---

## 4. Recommended recording parameters

Match the released configs exactly to reuse training recipes unchanged:

| parameter | value | why |
|---|---|---|
| **fps** | **exactly 20** | Trainers use `target_fps = video.fps = 20` (`train_codec.py:294-295`, `train_world_model.py:370`); derived fps must be within 0.5 of a multiple (`clips.py:31-32`). 20 also permits training at 10/5 fps. Use a fixed-timestep render/capture loop, not `requestAnimationFrame` wall-clock. |
| **resolution** | **512x288** (16:9) | Model runs at 288x512 (`configs/model/raev2_codec_tdown.yaml:37-38`, `latent_world_model.yaml:19-22`). Any resolution works — the codec pads-to-aspect + resizes on GPU (`codec_model.py preprocess_batch`) — but native 512x288 avoids all train-time resampling and keeps shards small. (Released RL data is 1280x720 with the codec downsizing; if you record higher-res, set `dataset.frame_size: [288, 512]`.) |
| **chunk length** | **exactly 80 frames (4.0 s)** | Codec clip_len=40; WM train clip_len=40; WM metrics eval needs `38 + 20*2 = 78` (`train_world_model.py:402`, `configs/eval_world_model.yaml:23-24`); offline-eval validation uses `timesteps*2 = 80` (`eval_world_model_offline.py:302`). 80 is the minimum that satisfies everything and is the shipped convention. |
| **actions** | 20 Hz, 1 line per frame | `actions.target_fps: 20` = one action per video frame (released default). |
| **video codec** | libx264, yuv420p, mp4, CFR 20 fps, short GOP | Only encode exercised by tests; torchcodec-decodable is the actual requirement. |
| **duration field** | `sum(chunk_frames) / 20.0` exactly | fps is derived from it. |
| **match length** | any multiple of 80 frames; drop the trailing partial chunk | Trailing short clips are dropped anyway (`clips.py:47-48`); a short final chunk is allowed (it just yields fewer clips) but its mp4/jsonl counts must still match its `chunk_frames` entry. |

Batch the model sees (n_players=1): `video (B, 40, 3, H, W)` uint8, `key_presses (B, 40, n_keys)` int32, mouse zeros/NaN.

---

## 5. Validation plan for generated data

Run from the repo root (`pixi run python ...` or with the `decode` extra installed). No dataset writer exists in `src/` — the test builders `tests/data/test_loader.py:_build` (and `test_training_loader.py:_build`) are the executable reference for your generator; diff your output structure against them.

**Step 1 — schema parse:**
```python
from mira.data.schema import Index
idx = Index.load("train/index.json")   # pydantic raises on chunk_indices errors etc.
assert idx.total_samples == len(idx.entries)
for e in idx.entries:
    assert "." not in e.match_id
    for p in e.perspectives:
        assert p.frames == sum(e.chunk_frames)
        fps = sum(e.chunk_frames) / e.perspectives[0].duration
        assert abs(fps - 20.0) <= 0.5
```

**Step 2 — planning + fps/stride/chunk-fit (no bytes read):**
```python
from mira.data import RocketScienceDataset
from mira.data.actions import KeyVocab
vocab = KeyVocab(("W","S","A","D","Space","LShiftKey"), on_unknown="error")  # error = catch typos
ds = RocketScienceDataset.from_local("train", vocab=vocab)
assert ds.max_clip_frames(target_fps=20) >= 80    # covers codec(40), WM(40), metrics(78), eval-val(80)
```

**Step 3 — random access (exercises tar member naming, decode, line counts, physics alignment):**
```python
clips = ds.load_match(ds.match_ids()[0], clip_len=40, target_fps=20, decode=True)
c = clips[0]
assert c.frames.shape == (1, 40, 3, 288, 512)     # (P, T, C, H, W) uint8
assert c.actions.shape == (1, 40, 6)              # int32 0/1
```
This raises `"tar member missing: ..."` on naming errors, `"decoded N != clip_len"` on frame-count errors, and `"N action steps != M"` on line-count errors. (Note: an actions file short by < stride lines is silently padded by hold-last — verify exact line counts in your generator, e.g. `len(bytes.splitlines()) == chunk_frames[c]` per member.)

**Step 4 — streaming (exercises contiguity + key parsing):** iterate `ds.iter_clips(clip_len=40, target_fps=20)` fully **with `logging` set to WARNING and treat any `"Skipping chunk/match ..."` warning as a failure** — the streaming path skips instead of raising (`dataset.py:585, 609`).

**Step 5 — training loader end-to-end:**
```python
from mira.data.training_loader import create_loader
loader = create_loader("train", clip_len=40, target_fps=20, n_players=1, batch_size=2,
                       valid_keys=["W","S","A","D","Space","LShiftKey"], infinite=False, num_workers=0)
batch, meta = next(iter(loader))
assert batch.video.dtype == torch.uint8 and batch.actions.key_presses.shape[-1] == 6
assert batch.actions.key_presses.any()           # sanity: actions aren't all-zero
```

**Step 6 — run the repo's own test suite patterns against your data**: adapt `tests/data/test_loader.py` / `test_training_loader.py` assertions (frame/action alignment, grouping) by pointing their `_build` fixture path at your generated split; also eyeball clips with `examples/explore.py` (`pixi run explore`, point `from_local` at your dir — "no physics track" is the expected graceful message if you omit physics; the keyboard HUD will render the RL layout, cosmetic only).

**Step 7 — smoke-train**: `python scripts/train_codec.py dataset=racing dataset.train_index=... dataset.test_index=... run.steps=20 run.compile=false` (needs DINOv3 weights via `RS_DINO_WEIGHTS_DIR`), then a few WM steps with `model.architecture.config.codec_checkpoint=...`. This is the only check that exercises the full contract including fps arithmetic in the trainers.

---

## 6. Hardcoded Rocket-League-isms (explicit list)

**Need NO code change for a keyboard racing game (config/data only):**

| item | location | note |
|---|---|---|
| 9-key `DEFAULT_RL_KEYS` fallback | `src/mira/data/actions.py:28-38`; used at `dataset.py:154`, `training_loader.py:290`, `actions.py:59-60` | Just always pass your vocab / actions yaml; the fallback silently applies if you forget. |
| `configs/actions/rocket_league.yaml`, `configs/dataset/rocket_league.yaml` | whole files | Add `racing.yaml` siblings; select via `defaults: - /actions@actions: racing` and `dataset=racing`. |
| Replay event names `GoalReplayStarted`/`GoalReplayEnded` | `src/mira/data/events.py:21-22` | Only matter if you use `exclude_replays`; reuse the names for any skip-worthy segments, no code change. |
| `team` field semantics | `schema.py:33` | Required int; set 0. |
| `N_PLAYERS = 4` module constant | `src/mira/data/dataset.py:36` | Unused by the read path; informational only. |
| Class name `RocketScienceDataset` | `dataset.py:150` | Cosmetic. |

**Need code changes ONLY for optional/cosmetic features:**

| item | location | change needed if you want it |
|---|---|---|
| Keyboard HUD layout (QWE/ASD/Shift-Space-Ctrl) and team colors | `src/mira/data/viz.py:28` (`_TEAM_COLORS`), `viz.py:34-39` (`_KB_POS`/`_KB_LABEL`) | Redraw for a racing key layout if you want correct viz overlays. |
| Physics viz/consistency: arena extents + 4-car assumption + RL FrameState | `src/mira/data/physics.py:30-34` (`FIELD_X/Y/Z`, `N_CARS = 4`), `physics.py:281-284`; `src/mira/data/state.py` (schema); radar in `viz.py:297-443` | Only if you ship physics and want radar/consistency checks; otherwise omit physics. |
| Per-player action-subset dropout keys `("Q","E","Space","LShiftKey","LControlKey")` | `src/mira/world_model/layers/action_encoder.py:31` (`DEFAULT_SUBSET_KEYS`); `subset_keys` not passed by `LatentWorldModel` (`latent_world_model.py:113-122`) | Irrelevant for n_players=1 (`dropout_action_per_player` off). If ever enabled, missing names degrade with a warning (`action_encoder.py:88-96`); pass racing-appropriate `subset_keys` for clean behavior. |

**Need code changes for a capability gap:**

| item | location | change |
|---|---|---|
| Analog input (steering wheel/trigger values, mouse) | `tensorize_actions` parses only `keys` (`actions.py:97`); loader hardcodes zero mouse + NaN sensitivity (`training_loader.py:122-127`); mouse channel fixed at 2 dims (`action_encoder.py`, `nn.Linear(2, mouse_dim)`) | The encoder side already supports `(B,T,2)` float32 mouse deltas + scalar sensitivity; a disk format + parsing path would have to be added to use them. **Recommendation: quantize analog to keys (multi-hot) and avoid code changes entirely.** |
| Multiplayer rollout action offset | `src/mira/inference/rollout.py` multiplayer branch slices at offset 0 vs the model's `off = atd-1` | Not applicable at n_players=1; only a hazard if you later build a multiplayer racing wrapper with a td>1 codec. |

**One conflict resolved by re-read:** `total_samples` — the schema comment (`schema.py:84`) defines it as the number of matches, and `_restrict_to_shards` (`dataset.py:233`) sets it to `len(entries)`. It is never otherwise validated; write `len(entries)`.