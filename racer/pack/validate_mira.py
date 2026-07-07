#!/usr/bin/env python3
"""Validate a packed racing split against the MIRA dataset contract (racer/DATASET_CONTRACT.md §5).

Runs the contract's validation steps 1-5 against one split directory (train/ or test/) and prints a
PASS/FAIL/SKIPPED report per step:

    1. schema parse (`mira.data.schema.Index`) + index invariants (match_id, frames, derived fps)
    2. planning: `RocketScienceDataset.from_local` with a strict vocab; `max_clip_frames >= 80`
    3. random access: `load_match(..., decode=True)` shape/dtype checks (frames + actions)
    4. streaming: full `iter_clips` pass; any "Skipping ..." log warning is a failure
    5. training loader: `create_loader` end-to-end batch checks (incl. `key_presses.any()`)

Environment: `mira` must be importable. This script first inserts the repo's `src/` (two levels up
from this file) onto `sys.path`; if you run it from elsewhere, `pip install -e /path/to/mira` into
your environment instead. Steps 3-5 additionally need torch + torchcodec + FFmpeg *shared*
libraries (a static ffmpeg binary is not enough); without them those steps are SKIPPED and the
decode-free variants still run. On this repo's packer env:

    LD_LIBRARY_PATH=racer/pack/.ffmpeg/lib racer/pack/.venv/bin/python \\
        racer/pack/validate_mira.py /path/to/dataset/train

Usage:
    validate_mira.py SPLIT_DIR [--clip-len 40] [--target-fps 20] [--keys W,S,A,D,Space,LShiftKey]
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass
from pathlib import Path

_REPO_SRC = Path(__file__).resolve().parents[2] / "src"
if _REPO_SRC.is_dir() and str(_REPO_SRC) not in sys.path:
    sys.path.insert(0, str(_REPO_SRC))

MIN_CHUNK_CLIP = 80  # covers codec(40), WM(40), WM metrics(78), offline-eval validation(80)


@dataclass
class StepResult:
    name: str
    status: str  # "PASS" | "FAIL" | "SKIPPED"
    detail: str = ""


def _probe_decode() -> str | None:
    """None if torchcodec's decoder loads (FFmpeg shared libs found), else the reason it cannot."""
    try:
        from torchcodec.decoders import VideoDecoder  # noqa: F401
    except Exception as err:  # torchcodec raises RuntimeError when no libav*.so can be dlopen-ed
        first_line = str(err).strip().splitlines()[0]
        return (
            f"{type(err).__name__}: {first_line} — decode needs torchcodec + FFmpeg SHARED libs; "
            f"put them on LD_LIBRARY_PATH (e.g. racer/pack/.ffmpeg/lib)"
        )
    return None


class _SkipCapture(logging.Handler):
    """Collects the streaming reader's 'Skipping ...' warnings (it skips instead of raising)."""

    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        msg = record.getMessage()
        if "Skipping" in msg:
            self.messages.append(msg)


# -- steps ---------------------------------------------------------------------


def step1_schema(split: Path, target_fps: int) -> StepResult:
    from mira.data.schema import Index

    idx = Index.load(split / "index.json")  # pydantic raises on schema/chunk_indices errors
    assert idx.total_samples == len(idx.entries), (
        f"total_samples={idx.total_samples} != len(entries)={len(idx.entries)}"
    )
    assert idx.entries, "index has no entries"
    for e in idx.entries:
        assert "." not in e.match_id, f"match_id contains '.': {e.match_id!r}"
        assert (split / e.shard).is_file(), f"{e.match_id}: shard missing: {e.shard}"
        for p in e.perspectives:
            assert p.frames == sum(e.chunk_frames), (
                f"{e.match_id}: perspective frames={p.frames} != sum(chunk_frames)"
            )
        fps = sum(e.chunk_frames) / e.perspectives[0].duration
        assert abs(fps - target_fps) <= 0.5, f"{e.match_id}: derived fps {fps:.3f} != {target_fps}"
    return StepResult("schema parse (Index)", "PASS", f"{len(idx.entries)} matches")


def step2_planning(split: Path, keys: tuple[str, ...], target_fps: int):
    from mira.data import RocketScienceDataset
    from mira.data.actions import KeyVocab

    vocab = KeyVocab(keys, on_unknown="error")  # error = catch key typos while validating
    ds = RocketScienceDataset.from_local(split, vocab=vocab)
    longest = ds.max_clip_frames(target_fps=target_fps)
    assert longest >= MIN_CHUNK_CLIP, f"max_clip_frames={longest} < {MIN_CHUNK_CLIP}"
    result = StepResult("planning (from_local + max_clip_frames)", "PASS", f"max_clip_frames={longest}")
    return result, ds


def step3_random_access(ds, clip_len: int, target_fps: int, n_keys: int, decode: bool) -> StepResult:
    import torch

    mode = f"decode={decode}"
    clips = ds.load_match(ds.match_ids()[0], clip_len=clip_len, target_fps=target_fps, decode=decode)
    assert clips, "load_match planned no clips"
    c = clips[0]
    assert c.actions.shape == (1, clip_len, n_keys), f"actions shape {tuple(c.actions.shape)}"
    assert c.actions.dtype == torch.int32, f"actions dtype {c.actions.dtype}"
    detail = f"{len(clips)} clips, actions {tuple(c.actions.shape)}"
    if decode:
        assert c.frames is not None, "decode=True returned no frames"
        p, t, ch = c.frames.shape[:3]
        assert (p, t, ch) == (1, clip_len, 3), f"frames shape {tuple(c.frames.shape)}"
        assert c.frames.dtype == torch.uint8, f"frames dtype {c.frames.dtype}"
        detail += f", frames {tuple(c.frames.shape)} uint8"
    return StepResult(f"random access (load_match, {mode})", "PASS", detail)


def step4_streaming(ds, clip_len: int, target_fps: int, decode: bool) -> StepResult:
    capture = _SkipCapture()
    data_logger = logging.getLogger("mira.data")
    data_logger.setLevel(logging.WARNING)
    data_logger.addHandler(capture)
    try:
        n = sum(1 for _ in ds.iter_clips(clip_len=clip_len, target_fps=target_fps, decode=decode))
    finally:
        data_logger.removeHandler(capture)
    assert n > 0, "streaming yielded no clips"
    if capture.messages:
        raise AssertionError(f"{len(capture.messages)} skip warning(s), first: {capture.messages[0]}")
    return StepResult(f"streaming (iter_clips, decode={decode})", "PASS", f"{n} clips, 0 skips")


def step5_loader(split: Path, keys: tuple[str, ...], clip_len: int, target_fps: int) -> StepResult:
    import torch

    from mira.data.schema import Index
    from mira.data.training_loader import create_loader

    e = Index.load(split / "index.json").entries[0]
    source_fps = round(sum(e.chunk_frames) / e.perspectives[0].duration)
    loader = create_loader(
        split,
        clip_len=clip_len,
        target_fps=target_fps,
        n_players=1,
        batch_size=2,
        num_workers=0,
        infinite=False,
        valid_keys=list(keys),
        source_fps=source_fps,
    )
    batch, meta = next(iter(loader))
    kp = batch.actions.key_presses
    assert batch.video.dtype == torch.uint8, f"video dtype {batch.video.dtype}"
    assert batch.video.shape[1:3] == (clip_len, 3), f"video shape {tuple(batch.video.shape)}"
    assert kp.shape == (batch.video.shape[0], clip_len, len(keys)), f"key_presses {tuple(kp.shape)}"
    assert kp.dtype == torch.int32, f"key_presses dtype {kp.dtype}"
    assert kp.any(), "key_presses are all-zero (actions not wired through?)"
    assert len(meta) == batch.video.shape[0], "metadata rows != batch rows"
    return StepResult(
        "training loader (create_loader)", "PASS",
        f"video {tuple(batch.video.shape)}, key_presses {tuple(kp.shape)}, any()=True",
    )  # fmt: skip


# -- runner --------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0], formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument("split", type=Path, help="packed split directory (holds index.json + shards)")
    parser.add_argument("--clip-len", type=int, default=40)
    parser.add_argument("--target-fps", type=int, default=20)
    parser.add_argument("--keys", type=str, default="W,S,A,D,Space,LShiftKey",
                        help="comma-separated key vocabulary, in training column order")  # fmt: skip
    args = parser.parse_args(argv)

    keys = tuple(k for k in args.keys.split(",") if k)
    split = args.split
    results: list[StepResult] = []
    no_decode = _probe_decode()
    ds = None

    def run(fn, *fn_args, name: str) -> object | None:
        try:
            out = fn(*fn_args)
        except Exception as err:  # noqa: BLE001 - every failure becomes a FAIL row
            results.append(StepResult(name, "FAIL", f"{type(err).__name__}: {err}"))
            return None
        if isinstance(out, tuple):
            results.append(out[0])
            return out[1]
        results.append(out)
        return out

    run(step1_schema, split, args.target_fps, name="schema parse (Index)")
    ds = run(step2_planning, split, keys, args.target_fps, name="planning (from_local + max_clip_frames)")

    if ds is None:
        results.append(StepResult("random access (load_match)", "SKIPPED", "planning failed"))
        results.append(StepResult("streaming (iter_clips)", "SKIPPED", "planning failed"))
    else:
        decode = no_decode is None
        run(step3_random_access, ds, args.clip_len, args.target_fps, len(keys), decode,
            name=f"random access (load_match, decode={decode})")  # fmt: skip
        if no_decode:
            results.append(StepResult("random access (frame decode)", "SKIPPED", no_decode))
        run(step4_streaming, ds, args.clip_len, args.target_fps, decode,
            name=f"streaming (iter_clips, decode={decode})")  # fmt: skip

    if no_decode:
        results.append(StepResult("training loader (create_loader)", "SKIPPED", no_decode))
    elif ds is not None:
        run(step5_loader, split, keys, args.clip_len, args.target_fps,
            name="training loader (create_loader)")  # fmt: skip
    else:
        results.append(StepResult("training loader (create_loader)", "SKIPPED", "planning failed"))

    print(f"\nMIRA dataset validation — {split}")
    print(f"clip_len={args.clip_len} target_fps={args.target_fps} keys={','.join(keys)}\n")
    for i, r in enumerate(results, start=1):
        pad = "." * max(2, 52 - len(r.name))
        print(f"  [{i}] {r.name} {pad} {r.status}" + (f"  ({r.detail})" if r.detail else ""))
    failed = [r for r in results if r.status == "FAIL"]
    skipped = [r for r in results if r.status == "SKIPPED"]
    print()
    if failed:
        print(f"RESULT: FAIL ({len(failed)} step(s) failed)")
        return 1
    if skipped:
        print(f"RESULT: PASS with {len(skipped)} step(s) skipped (decode unavailable?)")
        return 0
    print("RESULT: PASS (all steps)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
