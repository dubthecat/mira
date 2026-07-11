# racer/serve — NEURAL PLAY serving stack

The browser at `web/play` connects over WebSocket to a GPU pod running the
trained world model; the pod streams generated frames conditioned on the
player's live keys. **The game runs inside the model** — no sim, no renderer,
the HUD arrives baked into the pixels.

```
browser (web/lib/engine/neuralStream.js)
   │  { act: multi-hot keys }  @ 20 Hz
   ▼
serve_wm.py on a RunPod GPU pod          ┌─ context clip (dataset) primes 19 latents
   │  streaming_inference_step:          │
   │  kv-cached denoise of 1 latent  ◄───┘
   │  per 2 acts → codec decode → 2 frames
   ▼
   { frame: base64 JPEG 512x288 }  → canvas
```

| file | what |
|---|---|
| `serve_wm.py` | the WebSocket server (real model mode + `--fake` stack-check mode) |
| `PROTOCOL.md` | the wire protocol (hello/ready/act/frame/reset, liveness) |
| `test_client.py` | python end-to-end test client (handshake, 100 frames, reset, session cap) |
| `deploy_serve.py` | RunPod REST deploy (A6000 default, self-terminating, prints the ws:// URL) |
| `serve_pod.sh` | pod bootstrap (beacon → HF, runs the server, EXIT trap terminates the pod) |

Browser side: `web/lib/engine/neuralStream.js` (`NeuralStreamEngine`) + its
node test `web/lib/engine/neuralStream.test.mjs`; wiring notes in
`web/lib/engine/README.md`.

## Run locally — fake mode (no checkpoint, no GPU)

`--fake` serves procedurally generated moving-gradient JPEGs (key-responsive,
so you can SEE inputs land) through the exact same protocol/session/liveness
code. Verifies everything except the model itself.

```bash
# deps live in the pack venv (torch-cpu, numpy; websockets + pillow added)
racer/pack/.venv/bin/python racer/serve/serve_wm.py --fake --port 8765

# python client: handshake, 100 acts @20Hz -> 100 JPEGs, reset flow, session cap
racer/pack/.venv/bin/python racer/serve/test_client.py \
    --url ws://127.0.0.1:8765 --n 100 --check-reset --check-busy 2

# node/browser client (NeuralStreamEngine, spawns its own fake server):
node --test web/lib/engine/neuralStream.test.mjs
```

Measured on this repo's dev box (CPU only, localhost): 100/100 frames, 20.0
frames/s sustained, act→frame latency p50 ≈ 9 ms / p95 ≈ 11 ms, ~12 KB per
512x288 q80 JPEG, ~6.5 ms server-side per frame.

## Run locally — real mode (needs a trained checkpoint)

```bash
PYTHONPATH=src LD_LIBRARY_PATH=racer/pack/.ffmpeg/lib \
racer/pack/.venv/bin/python racer/serve/serve_wm.py \
    --checkpoint /path/to/run/checkpoint-000123/checkpoint.pth \
    --dataset racer/dataset/v1/test \
    --port 8765
```

- The checkpoint dir tree must contain `world_model_config.yaml` (standard
  trainer layout; `load_world_model` finds it in a parent dir) and the codec
  checkpoint it references must exist at the recorded path.
- Context priming: `--dataset <dir> [--match-id ID] [--clip-id N]` decodes a
  40-frame clip (needs torchcodec + FFmpeg 7 libs, hence `LD_LIBRARY_PATH`),
  or `--context ctx.pt` loads a pre-dumped tensor file — produce one with:

```bash
PYTHONPATH=src LD_LIBRARY_PATH=racer/pack/.ffmpeg/lib \
racer/pack/.venv/bin/python racer/serve/serve_wm.py \
    --dump-context ctx.pt --dataset racer/dataset/v1/test --clip-len 40
# -> {"video": (1,40,3,288,512) uint8, "key_presses": (1,40,6) int32, "keys": [...]}
```

  Ship `ctx.pt` inside the checkpoint bundle and the pod needs no torchcodec
  decode at all. (Verified locally against `racer/dataset/v1/test`.)
- Inference knobs: `--n-diffusion-steps 4` (default; raise for quality, costs
  latency linearly), `--noise-level 0.2|none`, `--schedule linear_quadratic`.
- The key vocabulary and frame size come from the checkpoint
  (`config.actions.valid_keys`, `video.height/width` — 288x512 @ 20 fps for
  the racing configs). Clients learn it from the `ready` message.

## Deploy on RunPod (when a checkpoint lands)

**Nothing here deploys automatically — every deploy spends money.** The pod is
cost-bounded three ways: the server exits after `--idle-exit` 900 s with no
sessions, `serve_pod.sh`'s EXIT trap DELETEs the pod, and the boot command has
a belt-and-braces terminate. There is no RunPod logs API: the pod self-reports
to `hf://<repo>/runs/<run-name>/` (`STARTED.txt` beacon contains the ws:// URL,
logs upload on exit).

1. Upload the serving bundle to the HF dataset repo (any prefix, e.g.
   `runs/train1/serve/`): `world_model_config.yaml` + `checkpoint.pth` + the
   codec checkpoint at the relative path recorded in the config, plus
   optionally `context.pt` (recommended — skips torchcodec on the pod).
2. Deploy:

```bash
RUNPOD_API_KEY=... HF_TOKEN=... python3 racer/serve/deploy_serve.py \
    --ckpt-prefix runs/train1/serve --run-name serve1
```

   Defaults: `NVIDIA RTX A6000`, SECURE cloud, 60 GB container disk, no
   volume, port `8765/tcp`, `--idle-exit 900`, `--max-sessions 2`. Override
   GPU with repeatable `--gpu "NVIDIA A100 80GB PCIe"`.
3. The script polls `GET /v1/pods/{id}` until `publicIp` + `portMappings`
   surface and prints the endpoint, e.g. `ws://100.65.0.119:30123` (raw-TCP
   exposure: RunPod maps container port 8765 to a random public port; the pod
   sees the same values as `RUNPOD_PUBLIC_IP` / `RUNPOD_TCP_PORT_8765` and
   writes them into the beacon). Then:

```bash
racer/pack/.venv/bin/python racer/serve/test_client.py --url ws://<ip>:<port> --n 100
```

4. Point the site at it: `NEXT_PUBLIC_NEURAL_WS_URL=ws://<ip>:<port>` (see
   `web/lib/engine/README.md`). Note the endpoint is plain `ws://` — a page
   served over https cannot open it (mixed content). For the Vercel deployment
   put a TLS proxy in front or use RunPod's https proxy variant; for local
   `next dev` (http) it works as-is.

Full-stack pod check without any checkpoint: `deploy_serve.py --fake`
(same image, networking, protocol — procedural frames).

## Cost / latency notes

- **A6000 (SECURE): ~$0.49/hr** — the default. 48 GB VRAM is far more than the
  1B model needs; it's the cheapest sensible card for 1-2 sessions.
- The upstream 5B MIRA reports 20 fps interactive serving on a single GPU
  (per their README, on datacenter-class hardware). **Ours is 1B**, so it
  should be comfortably real-time on an A100 and plausibly real-time on the
  A6000 — but this is unmeasured until a checkpoint exists. Measure with
  `scripts/bench_wm_speed.py <ckpt>` (pure denoise latency sweep over
  `--n-diffusion-steps`) and watch serve_wm's per-100-frames log line
  (`avg step ... -> N frames/s achievable`).
- Budget per latent (= 2 frames = 100 ms wall) at 20 fps:
  `n_diffusion_steps + 1` transformer forwards (kv-cached, 1 latent) + 1 codec
  decode. `--n-diffusion-steps 4` is the serving default; drop to 2 or
  `--noise-level none` (one fewer forward) before giving up on a GPU tier.
- If the GPU can't hold 20 fps the server does NOT fall over: acts coalesce
  (bounded queue) and frames stream at whatever rate it manages; the client
  just displays them (PROTOCOL.md "Timing and backpressure").
- Sessions are serialized on one GPU worker thread: two concurrent players
  halve each other's frame rate. `--max-sessions 2` is the honest default;
  raise only after measuring.
- Bandwidth: ~12 KB/frame q80 512x288 JPEG → ~2 Mbit/s per session at 20 fps.
  Trivial for the pod; fine over most home links.
