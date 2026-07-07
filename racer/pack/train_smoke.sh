#!/usr/bin/env bash
# MIRA racer smoke-train: validates the ENTIRE training chain (dataset ->
# loader -> codec training -> codec checkpoint -> world-model training) on a
# GPU pod, in ~30-60 min, without the gated DINOv3 weights (random-init
# backbone — mechanics identical, features meaningless; real training swaps in
# the licensed weights).
#
# Designed to run as a RunPod container command. Requires env:
#   HF_TOKEN          - HF token (dataset download + results upload)
#   HF_DATASET_REPO   - e.g. WilliamBolduc/racer-world-model-v1
#   GIT_REPO          - e.g. https://github.com/dubthecat/mira (public)
#   GIT_BRANCH        - e.g. racer-pipeline
#   RUNPOD_API_KEY    - for self-termination (billing stops even on failure)
#   RUNPOD_POD_ID     - injected by RunPod
#   RUN_NAME          - e.g. smoke1
set -uo pipefail

terminate() {
  code=$?
  echo "[smoke] exiting with code $code — uploading logs then terminating pod"
  python3 - << 'PYEOF' || true
import os, json, glob
from huggingface_hub import HfApi
api = HfApi(token=os.environ["HF_TOKEN"])
repo = os.environ["HF_DATASET_REPO"]
run = os.environ.get("RUN_NAME", "smoke")
for f in glob.glob("/workspace/logs/*"):
    try:
        api.upload_file(path_or_fileobj=f, path_in_repo=f"runs/{run}/{os.path.basename(f)}",
                        repo_id=repo, repo_type="dataset")
    except Exception as e:
        print("upload failed:", f, e)
PYEOF
  if [ -n "${RUNPOD_API_KEY:-}" ] && [ -n "${RUNPOD_POD_ID:-}" ]; then
    curl -s -X POST "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" \
      -H 'content-type: application/json' \
      -d "{\"query\":\"mutation { podTerminate(input: {podId: \\\"${RUNPOD_POD_ID}\\\"}) }\"}" || true
  fi
  exit "$code"
}
trap terminate EXIT

mkdir -p /workspace/logs /workspace/weights /workspace/data
cd /workspace
exec > >(tee -a /workspace/logs/smoke.log) 2>&1
echo "[smoke] $(date -u) starting on $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"

# --- deps -------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq ffmpeg git curl > /dev/null
pip install -q -U huggingface_hub

# --- code + dataset ---------------------------------------------------------
git clone --depth 1 -b "${GIT_BRANCH:-racer-pipeline}" "${GIT_REPO:?}" mira
python3 - << 'PYEOF'
import os
from huggingface_hub import snapshot_download
snapshot_download(os.environ["HF_DATASET_REPO"], repo_type="dataset",
                  token=os.environ["HF_TOKEN"], local_dir="/workspace/data",
                  allow_patterns=["train/*", "test/*"])
PYEOF
cd mira
pip install -q -e '.[train,decode,hf]'
python3 -c "import torch, torchcodec; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"

# --- random-init DINOv3 backbone under the expected filename ----------------
export RS_DINO_WEIGHTS_DIR=/workspace/weights
python3 - << 'PYEOF'
import torch
m = torch.hub.load("facebookresearch/dinov3", "dinov3_vitl16", source="github",
                   verbose=False, pretrained=False)
torch.save(m.state_dict(), "/workspace/weights/dinov3_vitl16_pretrain_lvd1689m-8aa4cbdd.pth")
print("saved random-init dinov3_vitl16 weights (SMOKE ONLY)")
PYEOF

# --- 1) codec smoke ----------------------------------------------------------
timeout 2400 python scripts/train_codec.py \
  dataset=racing \
  dataset.train_index=/workspace/data/train dataset.test_index=/workspace/data/test \
  wandb.mode=disabled run.steps=40 run.batch_size=2 run.compile=false \
  run.checkpoint_every="50%" run.output_dir=/workspace/logs/codec \
  validation.val_first=false validation.val_every="50%" validation.val_n_samples=64 \
  optim.scheduler.warmup_steps=10 optim.scheduler.decay_steps=0 \
  dataloader.num_workers=4 2>&1 | tee /workspace/logs/codec_train.log
CODEC_CKPT=$(find /workspace/logs/codec -name 'checkpoint.pth' | sort | tail -1)
echo "[smoke] codec checkpoint: ${CODEC_CKPT:?no codec checkpoint produced}"

# --- 2) world-model smoke ----------------------------------------------------
timeout 2400 python scripts/train_world_model.py \
  dataset=racing \
  dataset.train_index=/workspace/data/train dataset.test_index=/workspace/data/test \
  model.architecture.config.codec_checkpoint="$CODEC_CKPT" \
  wandb.mode=disabled run.steps=30 run.batch_size=1 run.compile=false \
  run.checkpoint_every="100%" run.output_dir=/workspace/logs/wm \
  dataloader.num_workers=4 2>&1 | tee /workspace/logs/wm_train.log

python3 - << 'PYEOF'
import json, re
result = {"status": "ok"}
for name in ("codec", "wm"):
    txt = open(f"/workspace/logs/{name}_train.log").read()
    losses = re.findall(r"loss[=:\s]+([0-9.]+[0-9])", txt)
    result[name] = {"loss_first": losses[0] if losses else None,
                    "loss_last": losses[-1] if losses else None,
                    "n_loss_lines": len(losses)}
json.dump(result, open("/workspace/logs/RESULT.json", "w"), indent=2)
print("[smoke] RESULT:", result)
PYEOF
echo "[smoke] SUCCESS $(date -u)"
