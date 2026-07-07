# Training the racing world model (RunPod + HuggingFace)

End-to-end: generated episodes → packed dataset → HF Hub → RunPod GPU pod →
codec → world model → interactive rollout.

## 0. Secrets

Set these as environment variables (never commit them; `.env.local` is
gitignored here for local use):

```bash
export HF_TOKEN=hf_...            # HuggingFace write token
export RUNPOD_API_KEY=rpa_...
export REPLICATE_API_TOKEN=r8_... # only for future asset-gen work
```

> **If a key has ever been pasted into a chat, an issue, or a log, treat it as
> compromised and rotate it first**: HF → Settings → Access Tokens; RunPod →
> Settings → API Keys; Replicate → Account → API tokens.

## 1. Generate + pack + upload (local, CPU only)

```bash
cd racer
node src/record/headless.js --episodes 200 --frames 2400 --seed0 1000 \
    --out episodes/run1 --concurrency 3
python3 pack/pack_dataset.py episodes/run1 --out dataset/v1
python3 pack/validate_mira.py dataset/v1/train && python3 pack/validate_mira.py dataset/v1/test
```

Upload (split dirs map to hub prefixes, which is what
`RocketScienceDataset.from_hub(repo, split=...)` expects):

```bash
python3 - << 'EOF'
import os
from huggingface_hub import HfApi
api = HfApi(token=os.environ["HF_TOKEN"])
repo = "<you>/racer-world-model-v1"
api.create_repo(repo, repo_type="dataset", private=True, exist_ok=True)
api.upload_folder(repo_id=repo, repo_type="dataset", folder_path="dataset/v1")
EOF
```

Throughput math: ~15 fps per recorder worker (software GL). 3 workers ≈ 160k
frames/hour on this 8-core box. The recorder needs no GPU, so any cheap
many-core machine (e.g. a 32-vCPU RunPod CPU pod with ~12 workers) generates
~15M frames/day. For reference: DIAMOND's CS:GO model used ~5.5M frames; start
smaller (~0.5–2M frames, i.e. 200–800 episodes) to see life first.

## 2. RunPod training pod

Interactive training wants an **on-demand GPU pod with a network volume**, not
serverless. (RunPod *flash* — github.com/runpod/flash — targets bursty
serverless endpoints; it's the right shape for later *inference* serving of the
world model, not for multi-day training runs.)

- GPU: 1× A100 80GB or H100 to start (the released world model config is ~1B
  params + a DINOv3-L codec encoder; both train comfortably on one 80GB card
  with the shipped batch sizes — scale out with `torchrun` later).
- Image: `runpod/pytorch:2.8.0-py3.12-cuda12.6` (or any CUDA 12.6 + torch 2.8).
- Volume: ≥ 500GB at `/workspace`.

On the pod:

```bash
cd /workspace
git clone <your fork of this repo> mira && cd mira
pip install -e '.[decode]'        # or: curl -fsSL https://pixi.sh/install.sh | sh && pixi run setup

# dataset
hf download <you>/racer-world-model-v1 --repo-type dataset --local-dir /workspace/data

# codec needs Meta's gated DINOv3 weights: accept the license at
# https://ai.meta.com/resources/models-and-libraries/dinov3-downloads/
# then place dinov3_vitl16_pretrain_lvd1689m-8aa4cbdd.pth under:
export RS_DINO_WEIGHTS_DIR=/workspace/weights
```

### Train

```bash
# 1) codec (RAE): learns the latent space the world model lives in
python scripts/train_codec.py dataset=racing \
    dataset.train_index=/workspace/data/train dataset.test_index=/workspace/data/test

# 2) world model (single-player, n_players=1 — plain LatentWorldModel)
python scripts/train_world_model.py dataset=racing \
    model.architecture.config.codec_checkpoint=/workspace/ckpts/codec/checkpoint.pth \
    dataset.train_index=/workspace/data/train dataset.test_index=/workspace/data/test

# 3) evaluate / rollout
python scripts/eval_world_model_offline.py /path/to/checkpoint-XXXX/checkpoint.pth
```

Notes (from DATASET_CONTRACT.md):
- `dataset=racing` + `configs/actions/racing.yaml` carry the 6-key action space;
  the action encoder auto-sizes to `len(valid_keys)`. Never rely on defaults —
  the code silently falls back to the 9 Rocket League keys if a vocab isn't passed.
- Keep the key list and its order frozen once training starts (checkpoint layout
  depends on it).
- Smoke-test the full contract first with a tiny run:
  `python scripts/train_codec.py dataset=racing run.steps=20 run.compile=false ...`

## 3. Playing inside the model

`src/mira/inference/rollout.py` drives the trained model with an action stream —
prime it with a few context frames from the dataset, then feed live 6-key
actions at 20 FPS. The `mira-wm.com` demo stack is the reference for real-time
serving; RunPod flash or a persistent GPU pod both work as hosts once a
checkpoint exists.
