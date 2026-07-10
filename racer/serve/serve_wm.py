#!/usr/bin/env python3
"""NEURAL PLAY server: stream world-model frames to a browser over WebSocket.

The game runs INSIDE the model: a trained MIRA-style world model (checkpoint via
``mira.inference.loading.load_world_model``) is primed with a context clip from the
training dataset, then stepped one latent frame at a time with
``LatentWorldModel.streaming_inference_step``, conditioned on the player's live
key presses. Latents decode to pixels through the codec decoder inside the same
checkpoint (``decode_to_video``), get JPEG-encoded and pushed down the socket.

Protocol (full spec in PROTOCOL.md, same directory):

    client -> {"type": "hello", "keys": [...]}          # once, after connect
    server -> {"type": "ready", "fps": 20, "keyOrder": [...], ...}
    client -> {"type": "act", "k": [0,1,0,...]}         # multi-hot, 20 Hz
    server -> {"type": "frame", "jpg": "<base64>", "i": 0, "gen_ms": ...}
    client -> {"type": "reset"}                          # re-prime, new "ready"

Timing: the model generates one LATENT per ``action_temporal_downsampling``
(= 2) acts, which decodes to ``temporal_downsampling`` (= 2) video frames, so
overall one frame per act. If the GPU is slower than 20 fps the server coalesces
queued acts (drops oldest beyond a small bound) and serves at whatever rate it
manages; the client just displays what arrives (no interpolation). Real-time
therefore depends on the GPU — measure with a real checkpoint.

``--fake`` skips the model entirely and serves procedurally generated
moving-gradient JPEG frames (numpy + Pillow, one frame per act, key-responsive)
so the whole stack — protocol, browser client, pod networking — can be verified
with no checkpoint and no GPU:

    racer/pack/.venv/bin/python racer/serve/serve_wm.py --fake --port 8765

Real mode (GPU pod, once a checkpoint exists):

    python racer/serve/serve_wm.py --checkpoint /ckpt/checkpoint.pth \\
        --dataset /data/test --port 8765 --idle-exit 900

Ops: one session per connection, ``--max-sessions`` cap (default 2), websocket
ping heartbeat, per-session idle timeout (no act for ``--idle-timeout`` s ->
close), and ``--idle-exit`` (server exits 0 after N s with zero sessions — the
pod bootstrap's EXIT trap then terminates the pod).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import logging
import math
import secrets
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger("serve_wm")

DEFAULT_KEYS = ["W", "S", "A", "D", "Space", "LShiftKey"]


def encode_jpeg(rgb, quality: int) -> bytes:
    """(H, W, 3) uint8 numpy -> JPEG bytes."""
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(rgb, mode="RGB").save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Frame sources
# ---------------------------------------------------------------------------


class FakeSource:
    """Procedural moving-gradient frames — verifies the whole stack without a model.

    One act -> one frame. The gradient phase responds to held keys (A/D pan
    horizontally, W/S vertically, Space pulses, LShiftKey speeds everything up)
    so a human in the browser can SEE the keys land server-side.
    """

    acts_per_step = 1
    frames_per_step = 1

    def __init__(self, key_order: list[str], width: int, height: int, quality: int):
        import numpy as np

        self.key_order = list(key_order)
        self.width, self.height, self.quality = width, height, quality
        yy, xx = np.meshgrid(np.arange(height, dtype=np.float32), np.arange(width, dtype=np.float32),
                             indexing="ij")
        self._xx, self._yy, self._np = xx, yy, np

    def make_state(self) -> dict:
        return {"phase_x": 0.0, "phase_y": 0.0, "t": 0}

    def step(self, state: dict, acts: list[list[int]]) -> list[bytes]:
        np = self._np
        k = acts[-1]
        held = {name: bool(k[i]) if i < len(k) else False for i, name in enumerate(self.key_order)}
        speed = 3.0 if held.get("LShiftKey") else 1.0
        state["phase_x"] += speed * (4.0 * held.get("D", False) - 4.0 * held.get("A", False) + 1.0)
        state["phase_y"] += speed * (4.0 * held.get("W", False) - 4.0 * held.get("S", False))
        state["t"] += 1
        t, px, py = state["t"], state["phase_x"], state["phase_y"]

        r = 127.5 * (1 + np.sin((self._xx + px * 3) / 42.0))
        g = 127.5 * (1 + np.sin((self._yy + py * 3) / 30.0))
        b = 127.5 * (1 + np.sin((self._xx + self._yy) / 64.0 + t / 9.0))
        if held.get("Space"):
            b = np.full_like(b, 220.0)
        rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)

        # moving marker block + key-echo squares along the bottom edge
        mx = int((self.width - 24) * (0.5 + 0.5 * math.sin(px / 60.0)))
        my = int((self.height - 24) * (0.5 + 0.5 * math.sin(py / 60.0 + 1.3)))
        rgb[my : my + 20, mx : mx + 20] = (255, 255, 255)
        for i, name in enumerate(self.key_order):
            x0 = 8 + i * 26
            rgb[self.height - 20 : self.height - 8, x0 : x0 + 18] = (
                (40, 230, 90) if held.get(name) else (35, 35, 45)
            )
        return [encode_jpeg(rgb, self.quality)]


class ModelSource:
    """The real thing: latents from a checkpointed world model, decoded by its codec.

    Priming (context video + actions -> latents) happens once at startup; each
    session clones the primed window. Per step: ``acts_per_step`` raw actions
    are appended to the session's action history, one latent is denoised via
    ``streaming_inference_step`` (rolling kv-cache), and it decodes to
    ``frames_per_step`` video frames.
    """

    def __init__(self, checkpoint: str, device: str, n_diffusion_steps: int,
                 noise_level: float | None, schedule: str, quality: int):
        import torch
        from mira.inference.loading import load_world_model
        from mira.world_model.config import WorldModelInferenceConfig

        self._torch = torch
        from pathlib import Path

        logger.info("loading world model from %s on %s ...", checkpoint, device)
        t0 = time.perf_counter()
        self.model, _run_cfg = load_world_model(Path(checkpoint), device=device)
        self.model.eval()
        logger.info("model loaded in %.1fs", time.perf_counter() - t0)

        m = self.model
        assert m.actions_per_video_frame == 1, (
            f"server assumes one action per video frame; checkpoint has "
            f"{m.actions_per_video_frame} (actions.target_fps != video.fps)"
        )
        self.key_order = list(m.config.actions.valid_keys)
        self.fps = m.config.video.fps
        self.width, self.height = m.config.video.width, m.config.video.height
        self.acts_per_step = m.action_temporal_downsampling  # raw acts per latent
        self.frames_per_step = m.temporal_downsampling  # video frames per latent
        self.quality = quality
        self.infer_cfg = WorldModelInferenceConfig(
            n_diffusion_steps=n_diffusion_steps, noise_level=noise_level, schedule_type=schedule
        )
        # Raw action steps streaming_inference_step reads per call, +1 for its
        # exclusive-end offset slice (see the model's action-offset comment).
        window = m.n_context_latents + 1
        self._hist_len = (window - 1) * self.acts_per_step + max(self.acts_per_step - 1, 0) + 1
        self.context_frames = window * m.temporal_downsampling

    def prime(self, context_batch) -> None:
        """Encode the context clip once; every session clones the primed window."""
        torch, m = self._torch, self.model
        window = m.n_context_latents + 1
        need = self.context_frames
        if context_batch.video.shape[1] < need:
            raise ValueError(
                f"context clip has {context_batch.video.shape[1]} frames; need >= {need} "
                f"((n_context_latents+1) * temporal_downsampling)"
            )
        context_batch = context_batch.slice_time(
            context_batch.video.shape[1] - need, None, fps=self.fps
        ).clone()
        with torch.inference_mode():
            z = m.init_streaming_inference(context_batch)  # (1, t_lat, h, w, c)
        self._z0 = z[:, -window:].clone()
        self._actions0 = context_batch.actions.slice_time(-self._hist_len, None).clone().to(m.device)
        logger.info(
            "primed: window=%d latents, %d ctx frames, %d-key vocab %s, %d acts/latent -> %d frames",
            window, need, len(self.key_order), self.key_order, self.acts_per_step, self.frames_per_step,
        )

    def make_state(self) -> dict:
        return {"z": self._z0.clone(), "actions": self._actions0.clone(), "kv": None}

    def step(self, state: dict, acts: list[list[int]]) -> list[bytes]:
        torch = self._torch
        m = self.model
        n_keys = len(self.key_order)
        from mira.world_model.actions_config import ActionTensors

        new = ActionTensors(config=m.config.actions, batch_size=1)
        k = torch.zeros((1, len(acts), n_keys), dtype=torch.int32)
        for t, a in enumerate(acts):
            for i in range(min(n_keys, len(a))):
                k[0, t, i] = 1 if a[i] else 0
        new.key_presses = k.to(m.device)
        new.mouse_movements = torch.zeros((1, len(acts), 2), device=m.device)

        with torch.inference_mode():
            state["actions"] = state["actions"].cat_time(new).slice_time(-self._hist_len, None)
            t0 = time.perf_counter()
            z_t, state["kv"] = m.streaming_inference_step(
                state["z"], state["actions"], state["kv"], self.infer_cfg
            )
            state["z"] = z_t
            denoise_ms = (time.perf_counter() - t0) * 1000
            t1 = time.perf_counter()
            frames = m.decode_to_video(z_t[:, -1:])  # (1, td, C, H, W) float in [0, 1]
            decode_ms = (time.perf_counter() - t1) * 1000
        arr = (frames[0].clamp(0, 1) * 255).to(torch.uint8).permute(0, 2, 3, 1).cpu().numpy()
        logger.debug("step: denoise %.1fms decode %.1fms", denoise_ms, decode_ms)
        return [encode_jpeg(a, self.quality) for a in arr]


# ---------------------------------------------------------------------------
# Context loading (real mode)
# ---------------------------------------------------------------------------


def load_context(args, action_config, fps: int, clip_len: int):
    """Build the priming VideoActionBatch from a dataset clip or a .pt tensor file.

    ``action_config`` must be the model's own ``ActionConfig`` in real mode —
    ``ActionTensors.cat_time`` (used per step) asserts config equality.
    """
    import torch

    from mira.data.batch import VideoActionBatch
    from mira.world_model.actions_config import ActionTensors

    cfg = action_config
    valid_keys = list(cfg.valid_keys)

    if args.context:
        blob = torch.load(args.context, map_location="cpu", weights_only=True)
        video, keys = blob["video"], blob["key_presses"]
        if video.dim() == 4:
            video, keys = video[None], keys[None]
        saved = blob.get("keys")
        if saved is not None and list(saved) != list(valid_keys):
            raise ValueError(f"context .pt key order {list(saved)} != model vocab {list(valid_keys)}")
    else:
        from mira.data.actions import KeyVocab
        from mira.data.dataset import RocketScienceDataset

        ds = RocketScienceDataset.from_local(args.dataset, vocab=KeyVocab(tuple(valid_keys)))
        match_id = args.match_id or ds.match_ids()[0]
        clips = ds.load_match(
            match_id, clip_len=clip_len, target_fps=fps, decode=True, perspective=0,
            clip_ids=[args.clip_id] if args.clip_id is not None else None, max_clips=1,
        )
        if not clips:
            raise ValueError(f"no clip found for match {match_id} (clip_id={args.clip_id})")
        clip = clips[0]
        video, keys = clip.frames, clip.actions  # (1, T, C, H, W) uint8 / (1, T, n_keys) int32
        logger.info("context: match %s clip %d (%d frames @ %dfps)", match_id, clip.clip_id,
                    video.shape[1], fps)

    actions = ActionTensors(config=cfg, batch_size=1)
    actions.key_presses = keys.to(torch.int32)
    actions.mouse_movements = torch.zeros((1, keys.shape[1], 2), dtype=torch.float32)
    return VideoActionBatch(video=video, actions=actions)


def dump_context(args) -> int:
    """--dump-context: write a priming .pt from the dataset (no model needed)."""
    import torch

    from mira.world_model.actions_config import ActionConfig

    keys = [k.strip() for k in args.keys.split(",") if k.strip()]
    cfg = ActionConfig(valid_keys=keys, source_fps=args.fps, target_fps=args.fps)

    class _A:  # minimal arg view for load_context
        context = None
        dataset = args.dataset
        match_id = args.match_id
        clip_id = args.clip_id

    batch = load_context(_A, cfg, args.fps, args.clip_len)
    torch.save(
        {"video": batch.video, "key_presses": batch.actions.key_presses, "keys": keys},
        args.dump_context,
    )
    print(f"wrote {args.dump_context}: video {tuple(batch.video.shape)} uint8, "
          f"key_presses {tuple(batch.actions.key_presses.shape)}, keys={keys}")
    return 0


# ---------------------------------------------------------------------------
# WebSocket server
# ---------------------------------------------------------------------------


class Session:
    def __init__(self, ws, source):
        self.ws = ws
        self.id = secrets.token_hex(3)
        self.state = source.make_state()
        self.pending: deque[list[int]] = deque(maxlen=8 * source.acts_per_step)
        self.acts_event = asyncio.Event()
        self.frame_idx = 0
        self.last_act = time.monotonic()
        self.gen_ms = deque(maxlen=200)


class Server:
    def __init__(self, source, args):
        self.source = source
        self.fps = getattr(source, "fps", args.fps)
        self.max_sessions = args.max_sessions
        self.idle_timeout = args.idle_timeout
        self.idle_exit = args.idle_exit
        self.sessions: set[Session] = set()
        self.last_active = time.monotonic()  # last time any session existed
        self.executor = ThreadPoolExecutor(max_workers=1)  # serialize GPU work
        self.stop = None  # future, set in run()

    def ready_msg(self, sess: Session) -> str:
        return json.dumps({
            "type": "ready",
            "fps": self.fps,
            "keyOrder": self.source.key_order,
            "width": self.source.width,
            "height": self.source.height,
            "mode": "fake" if isinstance(self.source, FakeSource) else "model",
            "actsPerStep": self.source.acts_per_step,
            "framesPerStep": self.source.frames_per_step,
            "session": sess.id,
        })

    async def handler(self, ws):
        if len(self.sessions) >= self.max_sessions:
            await ws.send(json.dumps({"type": "error", "code": "busy",
                                      "message": f"server full ({self.max_sessions} sessions)"}))
            await ws.close(1013, "busy")
            return

        # handshake: first message must be a hello
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=15)
            hello = json.loads(raw)
            assert hello.get("type") == "hello" and isinstance(hello.get("keys"), list)
        except Exception:
            try:
                await ws.send(json.dumps({"type": "error", "code": "bad_hello",
                                          "message": "expected {type:'hello', keys:[...]} first"}))
                await ws.close(1002, "bad hello")
            except Exception:
                pass
            return

        unknown = [k for k in hello["keys"] if k not in self.source.key_order]
        if unknown:
            logger.warning("hello keys not in vocab (ignored): %s", unknown)

        sess = Session(ws, self.source)
        self.sessions.add(sess)
        self.last_active = time.monotonic()
        logger.info("session %s open (%d/%d): client keys %s", sess.id, len(self.sessions),
                    self.max_sessions, hello["keys"])
        gen_task = asyncio.create_task(self.gen_loop(sess))
        try:
            await ws.send(self.ready_msg(sess))
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                mtype = msg.get("type")
                if mtype == "act":
                    k = msg.get("k")
                    if isinstance(k, list):
                        sess.pending.append([1 if v else 0 for v in k])
                        sess.last_act = time.monotonic()
                        sess.acts_event.set()
                elif mtype == "reset":
                    # drain, re-prime, restart the frame counter
                    gen_task.cancel()
                    try:
                        await gen_task
                    except asyncio.CancelledError:
                        pass
                    sess.pending.clear()
                    sess.acts_event.clear()
                    sess.state = await asyncio.get_running_loop().run_in_executor(
                        self.executor, self.source.make_state
                    )
                    sess.frame_idx = 0
                    sess.last_act = time.monotonic()
                    gen_task = asyncio.create_task(self.gen_loop(sess))
                    await ws.send(self.ready_msg(sess))
                elif mtype == "hello":
                    await ws.send(self.ready_msg(sess))
        except Exception as e:  # connection errors end the session
            logger.info("session %s connection ended: %r", sess.id, e)
        finally:
            gen_task.cancel()
            self.sessions.discard(sess)
            self.last_active = time.monotonic()
            logger.info("session %s closed after %d frames (%d/%d left)", sess.id, sess.frame_idx,
                        len(self.sessions), self.max_sessions)

    async def gen_loop(self, sess: Session):
        loop = asyncio.get_running_loop()
        n = self.source.acts_per_step
        while True:
            while len(sess.pending) < n:
                sess.acts_event.clear()
                await sess.acts_event.wait()
            acts = [sess.pending.popleft() for _ in range(n)]
            t0 = time.perf_counter()
            try:
                jpegs = await loop.run_in_executor(self.executor, self.source.step, sess.state, acts)
            except Exception:
                logger.exception("session %s: generation failed", sess.id)
                try:
                    await sess.ws.send(json.dumps({"type": "error", "code": "internal",
                                                   "message": "frame generation failed"}))
                    await sess.ws.close(1011, "generation failed")
                except Exception:
                    pass
                return
            gen_ms = (time.perf_counter() - t0) * 1000
            sess.gen_ms.append(gen_ms)
            per_frame = gen_ms / max(len(jpegs), 1)
            for jpg in jpegs:
                await sess.ws.send(json.dumps({
                    "type": "frame",
                    "jpg": base64.b64encode(jpg).decode("ascii"),
                    "i": sess.frame_idx,
                    "gen_ms": round(per_frame, 2),
                }))
                sess.frame_idx += 1
            if sess.frame_idx % 100 < len(jpegs):
                avg = sum(sess.gen_ms) / len(sess.gen_ms)
                eff = 1000 / (avg / self.source.frames_per_step) if avg > 0 else float("inf")
                logger.info("session %s: frame %d, avg step %.1fms -> %.1f frames/s achievable "
                            "(target %d)", sess.id, sess.frame_idx, avg, eff, self.fps)

    async def watchdog(self):
        while True:
            await asyncio.sleep(5)
            now = time.monotonic()
            for sess in list(self.sessions):
                if now - sess.last_act > self.idle_timeout:
                    logger.info("session %s idle > %ds, closing", sess.id, self.idle_timeout)
                    try:
                        await sess.ws.close(4000, "idle timeout")
                    except Exception:
                        pass
            if self.sessions:
                self.last_active = now
            elif self.idle_exit > 0 and now - self.last_active > self.idle_exit:
                logger.info("no sessions for %ds — idle-exit", self.idle_exit)
                self.stop.set_result(None)
                return

    async def run(self, host: str, port: int):
        from websockets.asyncio.server import serve

        self.stop = asyncio.get_running_loop().create_future()
        wd = asyncio.create_task(self.watchdog())
        async with serve(self.handler, host, port, ping_interval=20, ping_timeout=20,
                         max_size=2**20):
            logger.info("listening on ws://%s:%d (mode=%s, fps=%d, max_sessions=%d, "
                        "idle_timeout=%ds, idle_exit=%ds)", host, port,
                        "fake" if isinstance(self.source, FakeSource) else "model",
                        self.fps, self.max_sessions, self.idle_timeout, self.idle_exit)
            print(f"listening ws://{host}:{port}", flush=True)  # machine-readable readiness line
            await self.stop
        wd.cancel()


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--checkpoint", help="world-model checkpoint (.pth / checkpoint dir)")
    p.add_argument("--fake", action="store_true",
                   help="no model: serve procedural gradient frames (stack verification)")
    # context priming (real mode): dataset clip or .pt tensor file
    p.add_argument("--dataset", help="dataset dir (index.json) for the context clip")
    p.add_argument("--match-id", default=None, help="match to prime from (default: first)")
    p.add_argument("--clip-id", type=int, default=None, help="clip id within the match (default: first)")
    p.add_argument("--context", default=None, help=".pt context file {video, key_presses[, keys]}")
    p.add_argument("--dump-context", default=None, metavar="OUT_PT",
                   help="write a context .pt from --dataset and exit (no model load)")
    p.add_argument("--clip-len", type=int, default=40, help="context frames for --dump-context")
    # net / ops
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--max-sessions", type=int, default=2)
    p.add_argument("--idle-timeout", type=float, default=120, help="per-session: close after N s without an act")
    p.add_argument("--idle-exit", type=float, default=0,
                   help="whole server: exit 0 after N s with no sessions (0 = never; pods use 900)")
    # frames
    p.add_argument("--fps", type=int, default=20, help="nominal fps advertised in 'ready' (fake mode)")
    p.add_argument("--width", type=int, default=512, help="fake-mode frame width")
    p.add_argument("--height", type=int, default=288, help="fake-mode frame height")
    p.add_argument("--jpeg-quality", type=int, default=80)
    p.add_argument("--keys", default=",".join(DEFAULT_KEYS),
                   help="fake-mode / dump-context key vocabulary (CSV; real mode uses the checkpoint's)")
    # inference knobs (real mode)
    p.add_argument("--device", default=None, help="cuda / cpu (default: cuda if available)")
    p.add_argument("--n-diffusion-steps", type=int, default=4)
    p.add_argument("--noise-level", type=lambda s: None if s.lower() == "none" else float(s), default=0.2)
    p.add_argument("--schedule", default="linear_quadratic", choices=["linear", "linear_quadratic"])
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    if args.dump_context:
        if not args.dataset:
            print("error: --dump-context requires --dataset", file=sys.stderr)
            return 2
        return dump_context(args)

    if args.fake:
        keys = [k.strip() for k in args.keys.split(",") if k.strip()]
        source = FakeSource(keys, args.width, args.height, args.jpeg_quality)
    else:
        if not args.checkpoint:
            print("error: --checkpoint required (or use --fake)", file=sys.stderr)
            return 2
        if not (args.dataset or args.context):
            print("error: real mode needs a context: --dataset [--match-id] or --context file.pt",
                  file=sys.stderr)
            return 2
        import torch

        device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
        source = ModelSource(args.checkpoint, device, args.n_diffusion_steps,
                             args.noise_level, args.schedule, args.jpeg_quality)
        context = load_context(args, source.model.config.actions, source.fps, source.context_frames)
        source.prime(context)

    server = Server(source, args)
    try:
        asyncio.run(server.run(args.host, args.port))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
