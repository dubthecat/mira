#!/usr/bin/env bash
# NEURAL PLAY pod bootstrap: run serve_wm.py on a RunPod GPU pod, self-reporting
# and self-terminating (same conventions as racer/pack/train_smoke.sh — there is
# NO RunPod logs API, so the script uploads its own logs to HF, and the EXIT trap
# DELETEs the pod).
#
# Launched by racer/serve/deploy_serve.py as the container command. Env:
#   HF_TOKEN             - HF token (checkpoint/dataset download + log upload)
#   HF_DATASET_REPO      - e.g. WilliamBolduc/racer-world-model-v1 (beacon/logs +
#                          checkpoint + context source)
#   RUNPOD_TERMINATE_KEY - ACCOUNT api key for self-termination. Must NOT be
#                          named RUNPOD_API_KEY: RunPod injects its own
#                          pod-scoped key under that name, which can't delete pods
#   RUNPOD_POD_ID        - injected by RunPod
#   RUN_NAME             - e.g. serve1 (logs land in hf://$HF_DATASET_REPO/runs/$RUN_NAME/)
#   GIT_REPO / GIT_BRANCH- the mira repo to clone
#   SERVE_FAKE           - "1" = --fake mode (no checkpoint/GPU model; stack check)
#   CKPT_PREFIX          - real mode: path prefix inside HF_DATASET_REPO holding the
#                          serving bundle: world_model_config.yaml + checkpoint.pth
#                          (+ codec checkpoint it references) [+ context.pt]
#   PORT (8765) / IDLE_EXIT (900) / MAX_SESSIONS (2) / SERVE_EXTRA (extra args)
#   MAX_LIFETIME         - hard cap in seconds (86400) — belt and braces
set -uo pipefail

PORT="${PORT:-8765}"
IDLE_EXIT="${IDLE_EXIT:-900}"
MAX_SESSIONS="${MAX_SESSIONS:-2}"
MAX_LIFETIME="${MAX_LIFETIME:-86400}"

terminate() {
  code=$?
  echo "[serve] exiting with code $code — uploading logs then terminating pod"
  python3 - << 'PYEOF' || true
import os, glob
from huggingface_hub import HfApi
api = HfApi(token=os.environ["HF_TOKEN"])
repo = os.environ["HF_DATASET_REPO"]
run = os.environ.get("RUN_NAME", "serve")
for f in glob.glob("/workspace/logs/*"):
    try:
        api.upload_file(path_or_fileobj=f, path_in_repo=f"runs/{run}/{os.path.basename(f)}",
                        repo_id=repo, repo_type="dataset")
    except Exception as e:
        print("upload failed:", f, e)
PYEOF
  if [ -n "${RUNPOD_TERMINATE_KEY:-}" ] && [ -n "${RUNPOD_POD_ID:-}" ]; then
    # documented terminate: DELETE /v1/pods/{id} (docs.runpod.io/pods/manage-pods)
    resp=$(curl -s -w " http=%{http_code}" -X DELETE "https://rest.runpod.io/v1/pods/${RUNPOD_POD_ID}" \
      -H "Authorization: Bearer ${RUNPOD_TERMINATE_KEY}" || true)
    echo "[serve] terminate response: $resp"
  fi
  exit "$code"
}
trap terminate EXIT INT TERM

mkdir -p /workspace/logs /workspace/ckpt /workspace/data
cd /workspace
exec > >(tee -a /workspace/logs/serve.log) 2>&1
echo "[serve] $(date -u) starting on $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"

# --- deps -------------------------------------------------------------------
# runpod images keep torch in a venv activated via bashrc, which non-login
# `bash -c` shells skip — find a python that has torch before anything else
for cand in python3 /opt/venv/bin/python3 /workspace/venv/bin/python3 /venv/bin/python3; do
  if "$cand" -c "import torch" 2>/dev/null; then
    export PATH="$(dirname "$(command -v "$cand" || echo "$cand")"):$PATH"
    break
  fi
done
python3 -c "import torch" || { echo "[serve] FATAL: no torch-enabled python found"; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq ffmpeg git curl > /dev/null
pip install -q -U huggingface_hub websockets pillow

# beacon: prove the container ran + SELF-REPORT THE WS ENDPOINT (RunPod injects
# RUNPOD_PUBLIC_IP and RUNPOD_TCP_PORT_<port> for exposed tcp ports; the same
# mapping is what deploy_serve.py reads from GET /v1/pods/{id} portMappings)
tcp_var="RUNPOD_TCP_PORT_${PORT}"
export WS_URL="ws://${RUNPOD_PUBLIC_IP:-?}:${!tcp_var:-?}"
python3 - << 'PYEOF' || true
import os, io
from huggingface_hub import HfApi
api = HfApi(token=os.environ["HF_TOKEN"])
gpu = os.popen("nvidia-smi --query-gpu=name --format=csv,noheader").read().strip()
msg = (f"started pod={os.environ.get('RUNPOD_POD_ID','?')} gpu={gpu}\n"
       f"ws={os.environ.get('WS_URL','?')}\n"
       f"mode={'fake' if os.environ.get('SERVE_FAKE') == '1' else 'model'}\n")
api.upload_file(path_or_fileobj=io.BytesIO(msg.encode()),
                path_in_repo=f"runs/{os.environ.get('RUN_NAME','serve')}/STARTED.txt",
                repo_id=os.environ["HF_DATASET_REPO"], repo_type="dataset")
print("[serve] beacon uploaded:", msg.replace(chr(10), " "))
PYEOF
echo "[serve] websocket endpoint: $WS_URL"

# --- code -------------------------------------------------------------------
git clone --depth 1 -b "${GIT_BRANCH:-racer-pipeline}" "${GIT_REPO:?}" mira
cd mira

SERVE_ARGS=(--host 0.0.0.0 --port "$PORT" --idle-exit "$IDLE_EXIT" --max-sessions "$MAX_SESSIONS")

if [ "${SERVE_FAKE:-0}" = "1" ]; then
  # fake mode needs no mira install, no checkpoint: numpy ships with torch,
  # websockets/pillow were installed above
  SERVE_ARGS+=(--fake)
else
  # torchcodec pinned: newer wheels want CUDA 13 (libnvrtc.so.13) but the
  # image ships torch 2.8 / CUDA 12.8 — 0.7.0 is the repo's pinned pairing
  pip install -q -e '.[hydra]' 'torchcodec==0.7.0'
  # serving bundle: world_model_config.yaml + checkpoint.pth (+ codec ckpt it
  # references, as a RELATIVE path) [+ context.pt] under $CKPT_PREFIX
  python3 - << 'PYEOF'
import os
from huggingface_hub import snapshot_download
snapshot_download(os.environ["HF_DATASET_REPO"], repo_type="dataset",
                  token=os.environ["HF_TOKEN"], local_dir="/workspace/ckpt",
                  allow_patterns=[f"{os.environ['CKPT_PREFIX'].rstrip('/')}/*"])
PYEOF
  CKPT=$(find "/workspace/ckpt/${CKPT_PREFIX:?}" -name 'checkpoint.pth' | sort | tail -1)
  echo "[serve] checkpoint: ${CKPT:?no checkpoint.pth under CKPT_PREFIX}"
  SERVE_ARGS+=(--checkpoint "$CKPT")

  CONTEXT=$(find "/workspace/ckpt/${CKPT_PREFIX}" -name 'context.pt' | head -1)
  if [ -n "$CONTEXT" ]; then
    SERVE_ARGS+=(--context "$CONTEXT")
  else
    # no context.pt in the bundle: prime from the dataset's test split
    python3 - << 'PYEOF'
import os
from huggingface_hub import snapshot_download
snapshot_download(os.environ["HF_DATASET_REPO"], repo_type="dataset",
                  token=os.environ["HF_TOKEN"], local_dir="/workspace/data",
                  allow_patterns=["test/*"])
PYEOF
    SERVE_ARGS+=(--dataset /workspace/data/test)
  fi
fi

# shellcheck disable=SC2086  # SERVE_EXTRA is deliberately word-split
echo "[serve] launching: serve_wm.py ${SERVE_ARGS[*]} ${SERVE_EXTRA:-}"
timeout "$MAX_LIFETIME" python3 racer/serve/serve_wm.py "${SERVE_ARGS[@]}" ${SERVE_EXTRA:-} \
  2>&1 | tee /workspace/logs/serve_wm.log
echo "[serve] server exited $(date -u) — idle-exit or lifetime cap; trap terminates the pod"
