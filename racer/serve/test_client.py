#!/usr/bin/env python3
"""End-to-end WebSocket test client for serve_wm.py (works against --fake or a real model).

Does the hello handshake, streams N act messages paced at the advertised fps, and
asserts N JPEG frames come back with sane sizes and latency. Optionally also checks
the reset flow and the --max-sessions "busy" rejection.

    racer/pack/.venv/bin/python racer/serve/test_client.py --url ws://127.0.0.1:8765 \\
        --n 100 --check-reset --check-busy 2

Exit code 0 = all assertions passed.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import statistics
import sys
import time

from websockets.asyncio.client import connect

DEFAULT_KEYS = ["W", "S", "A", "D", "Space", "LShiftKey", "F"]


def fail(msg: str):
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


async def handshake(ws, keys):
    await ws.send(json.dumps({"type": "hello", "keys": keys}))
    ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
    if ready.get("type") == "error":
        return ready
    assert ready.get("type") == "ready", f"expected ready, got {ready}"
    assert isinstance(ready.get("keyOrder"), list) and ready.get("fps"), f"bad ready: {ready}"
    return ready


def multi_hot(key_order, held):
    return [1 if k in held else 0 for k in key_order]


async def stream_frames(ws, ready, n, fps):
    """Send n acts paced at fps while collecting n frames; returns (frames, latencies)."""
    key_order = ready["keyOrder"]
    send_times: list[float] = []
    frames: list[dict] = []
    latencies: list[float] = []

    async def recv_loop():
        while len(frames) < n:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
            if msg.get("type") != "frame":
                continue
            i = msg["i"]
            jpg = base64.b64decode(msg["jpg"])
            if i < len(send_times):
                latencies.append(time.perf_counter() - send_times[i])
            frames.append({"i": i, "bytes": jpg, "gen_ms": msg.get("gen_ms")})

    recv_task = asyncio.create_task(recv_loop())
    period = 1.0 / fps
    next_t = time.perf_counter()
    cycles = [set("W"), {"W", "A"}, {"W"}, {"W", "D"}, {"Space"}, {"LShiftKey", "W"}, set()]
    for j in range(n):
        held = cycles[j % len(cycles)]
        send_times.append(time.perf_counter())
        await ws.send(json.dumps({"type": "act", "k": multi_hot(key_order, held)}))
        next_t += period
        delay = next_t - time.perf_counter()
        if delay > 0:
            await asyncio.sleep(delay)
    await asyncio.wait_for(recv_task, timeout=120)
    return frames, latencies


def check_frames(frames, n, label):
    assert len(frames) == n, f"{label}: expected {n} frames, got {len(frames)}"
    idxs = [f["i"] for f in frames]
    assert idxs == list(range(idxs[0], idxs[0] + n)), f"{label}: non-contiguous frame indices {idxs[:10]}..."
    for f in frames:
        b = f["bytes"]
        assert b[:2] == b"\xff\xd8" and b[-2:] == b"\xff\xd9", f"{label}: frame {f['i']} not a JPEG"
        assert 1_000 < len(b) < 300_000, f"{label}: frame {f['i']} suspicious size {len(b)}B"


async def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--url", default="ws://127.0.0.1:8765")
    p.add_argument("--n", type=int, default=100, help="acts to send / frames to expect")
    p.add_argument("--keys", default=",".join(DEFAULT_KEYS), help="key names sent in hello (CSV)")
    p.add_argument("--check-reset", action="store_true", help="also verify the reset flow")
    p.add_argument("--check-busy", type=int, default=0, metavar="MAX",
                   help="also verify session cap: MAX total sessions ok, MAX+1 refused")
    args = p.parse_args()
    keys = [k.strip() for k in args.keys.split(",") if k.strip()]

    async with connect(args.url, max_size=2**20) as ws:
        t0 = time.perf_counter()
        ready = await handshake(ws, keys)
        print(f"ready: mode={ready.get('mode')} fps={ready['fps']} "
              f"{ready.get('width')}x{ready.get('height')} keyOrder={ready['keyOrder']} "
              f"(handshake {1000 * (time.perf_counter() - t0):.0f}ms)")

        t0 = time.perf_counter()
        frames, lat = await stream_frames(ws, ready, args.n, ready["fps"])
        wall = time.perf_counter() - t0
        check_frames(frames, args.n, "main")
        sizes = [len(f["bytes"]) for f in frames]
        gen = [f["gen_ms"] for f in frames if f.get("gen_ms") is not None]
        lat_ms = sorted(1000 * v for v in lat)
        print(f"OK: {args.n} acts -> {len(frames)} JPEG frames in {wall:.2f}s "
              f"({len(frames) / wall:.1f} frames/s achieved)")
        print(f"    jpeg size: min {min(sizes)}B  median {int(statistics.median(sizes))}B  max {max(sizes)}B")
        if lat_ms:
            print(f"    act->frame latency: p50 {lat_ms[len(lat_ms) // 2]:.1f}ms  "
                  f"p95 {lat_ms[int(len(lat_ms) * 0.95) - 1]:.1f}ms  max {lat_ms[-1]:.1f}ms")
        if gen:
            print(f"    server per-frame gen: mean {statistics.mean(gen):.1f}ms")

        if args.check_reset:
            await ws.send(json.dumps({"type": "reset"}))
            # frames generated before the reset landed may still be in flight; skip them
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
                if msg.get("type") == "ready":
                    break
                assert msg.get("type") == "frame", f"unexpected during reset: {msg}"
            frames2, _ = await stream_frames(ws, ready, 5, ready["fps"])
            check_frames(frames2, 5, "post-reset")
            assert frames2[0]["i"] == 0, f"post-reset frame index should restart at 0, got {frames2[0]['i']}"
            print("OK: reset -> ready -> frame indices restart at 0")

        if args.check_busy:
            extras = []
            try:
                for s in range(args.check_busy - 1):  # this conn occupies one slot
                    w = await connect(args.url, max_size=2**20)
                    extras.append(w)
                    r = await handshake(w, keys)
                    assert r.get("type") == "ready", f"extra session {s} refused early: {r}"
                w = await connect(args.url, max_size=2**20)
                extras.append(w)
                # over-cap connections are refused proactively (error + close, before any hello)
                over = json.loads(await asyncio.wait_for(w.recv(), timeout=10))
                assert over.get("type") == "error" and over.get("code") == "busy", (
                    f"session {args.check_busy + 1} should be refused busy, got {over}"
                )
                print(f"OK: session cap enforced at {args.check_busy} (extra connection got 'busy')")
            finally:
                for w in extras:
                    await w.close()

    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except AssertionError as e:
        fail(str(e))
