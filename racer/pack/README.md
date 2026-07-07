# racer/pack — episode packer + validator for the MIRA data pipeline

Converts raw racing-game episode recordings (per-episode `chunk_*.mp4` + `actions.jsonl` +
optional `physics.jsonl` + `meta.json`) into the WebDataset format `mira.data` trains on. The
authoritative format spec is [`../DATASET_CONTRACT.md`](../DATASET_CONTRACT.md).

## Pack

Stdlib-only; `ffprobe` on PATH enables exact per-chunk frame-count verification (on by default,
`--no-verify-frames` to skip):

```sh
python racer/pack/pack_dataset.py --episodes /path/to/episodes --out /path/to/dataset
# split control: every Nth episode (sorted by match_id) to test, or explicit ids
python racer/pack/pack_dataset.py --episodes eps --out ds --test-every 10
python racer/pack/pack_dataset.py --episodes eps --out ds --test-ids id1,id2 --matches-per-shard 8
```

Output: `<out>/train/` and `<out>/test/`, each holding `index.json` + `dataset_*.tar` shards
(all chunks of a match in one tar; sample key `{match_id}_c{chunk:05d}`, members
`.p0.mp4` / `.p0.jsonl` / optional `.p0.physics.jsonl`).

## Validate

`validate_mira.py` runs the contract §5 steps 1–5 (schema parse, planning, random access,
streaming, training loader) against one split dir. It needs `mira` importable (it auto-inserts the
repo's `src/`; otherwise `pip install -e .`) plus torch + torchcodec + FFmpeg **shared** libraries
for the decode steps — a static ffmpeg binary is not enough. Decode steps are reported SKIPPED
(and the decode-free variants still run) when torchcodec can't load FFmpeg.

This directory ships a ready environment on this machine: `.venv` (python3.12, CPU torch 2.8,
torchcodec 0.7, pydantic/numpy/einops) and `.ffmpeg` (conda-forge FFmpeg 7 shared libs + ffprobe):

```sh
LD_LIBRARY_PATH=racer/pack/.ffmpeg/lib racer/pack/.venv/bin/python \
    racer/pack/validate_mira.py /path/to/dataset/train \
    --clip-len 40 --target-fps 20 --keys W,S,A,D,Space,LShiftKey
```

To recreate the environment elsewhere:

```sh
python3.12 -m venv racer/pack/.venv && . racer/pack/.venv/bin/activate
pip install "torch==2.8.*" --index-url https://download.pytorch.org/whl/cpu
pip install "torchcodec==0.7.*" --index-url https://download.pytorch.org/whl/cpu
pip install pydantic numpy einops
micromamba create -p racer/pack/.ffmpeg -c conda-forge 'ffmpeg>=7,<8'   # FFmpeg 7 SHARED libs
```

## Upload to the HuggingFace Hub

The split dirs map 1:1 to hub prefixes: `<out>/train` → `train/`, `<out>/test` → `test/`, which is
what `RocketScienceDataset.from_hub(repo, split="train")` expects (contract §1.1). Token comes from
the `HF_TOKEN` env var — never hardcode it:

```python
import os
from huggingface_hub import HfApi

api = HfApi(token=os.environ["HF_TOKEN"])
api.create_repo("your-org/racing-dataset", repo_type="dataset", exist_ok=True)
for split in ("train", "test"):
    api.upload_folder(
        repo_id="your-org/racing-dataset",
        repo_type="dataset",
        folder_path=f"/path/to/dataset/{split}",
        path_in_repo=split,
    )
```

## Train

`configs/actions/racing.yaml` + `configs/dataset/racing.yaml` select the 6-key racing vocabulary
(`W,S,A,D,Space,LShiftKey` — order is load-bearing) with `n_players: 1`:

```sh
python scripts/train_codec.py dataset=racing dataset.train_index=/path/dataset/train \
    dataset.test_index=/path/dataset/test
```
