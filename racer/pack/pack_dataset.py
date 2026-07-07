#!/usr/bin/env python3
"""Pack raw racing-game episode recordings into a MIRA WebDataset split (train/ + test/).

Input layout (`--episodes DIR`): one subdirectory per episode (= one "match"), named by its
match_id (no dots, no trailing `_c<digits>`), containing:

    chunk_00000.mp4, chunk_00001.mp4, ...   # H.264 yuv420p, exactly meta chunkFrames[c] frames each
    actions.jsonl                           # one line per frame across the WHOLE episode
    physics.jsonl                           # optional, one line per frame across the whole episode
    meta.json                               # {"matchId", "seed", "fps", "frames", "chunkFrames",
                                            #  "events", "track"}

Output layout (`--out DIR`), per the contract in racer/DATASET_CONTRACT.md:

    train/index.json + train/dataset_00000.tar ...     # one tar sample per (match, chunk):
    test/index.json  + test/dataset_00000.tar ...      #   {match_id}_c{c:05d}.p0.{mp4,jsonl[,physics.jsonl]}

Episodes are split by match: `--test-ids` names the test episodes explicitly, otherwise every
`--test-every`-th episode of the match_id-sorted list (the 1st, N+1th, ...) goes to test. All chunks
of a match land in one uncompressed tar; `--matches-per-shard` matches share a shard. Packing is
strictly validated (meta/actions/physics line counts, chunk presence, and — with `--verify-frames`,
the default — per-chunk mp4 frame counts via ffprobe).

Stdlib only; ffprobe (from an ffmpeg install on PATH) is the single optional external dependency.

Usage:
    python pack_dataset.py --episodes /path/to/episodes --out /path/to/dataset
    python pack_dataset.py --episodes eps --out ds --test-ids 2026-01-01T00-00-00Z-abc123
    python pack_dataset.py --episodes eps --out ds --test-every 5 --no-verify-frames
"""

from __future__ import annotations

import argparse
import io
import json
import re
import shutil
import subprocess
import sys
import tarfile
from dataclasses import dataclass
from pathlib import Path

TRAILING_CHUNK_RE = re.compile(r".*_c\d+$")  # would break the {match_id}_c{idx} key round-trip


class PackError(RuntimeError):
    """A validation or packing failure; the message names the offending episode."""


@dataclass(frozen=True)
class Episode:
    """One validated raw episode (metadata only; bytes are read again at pack time)."""

    match_id: str
    path: Path
    fps: float
    chunk_frames: list[int]
    arena: str | None
    has_physics: bool

    @property
    def frames(self) -> int:
        return sum(self.chunk_frames)

    def chunk_mp4(self, c: int) -> Path:
        return self.path / f"chunk_{c:05d}.mp4"


# -- episode loading & validation ------------------------------------------


def _load_meta(path: Path, match_id: str) -> dict:
    meta_path = path / "meta.json"
    if not meta_path.is_file():
        raise PackError(f"episode {match_id}: missing meta.json")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise PackError(f"episode {match_id}: meta.json is not valid JSON: {err}") from err
    if not isinstance(meta, dict):
        raise PackError(f"episode {match_id}: meta.json must hold a JSON object")
    return meta


def _arena(meta: dict) -> str | None:
    """Free-form arena string from the recorder's track name/seed, e.g. 'canyon-seed42'."""
    track = meta.get("track") or {}
    name = track.get("name") or track.get("id") if isinstance(track, dict) else None
    seed = meta.get("seed")
    if name is not None and seed is not None:
        return f"{name}-seed{seed}"
    if name is not None:
        return str(name)
    return f"seed{seed}" if seed is not None else None


def _validate_jsonl(path: Path, match_id: str, expected_lines: int, what: str) -> None:
    """Check a whole-episode jsonl has exactly `expected_lines` parseable lines."""
    lines = path.read_bytes().splitlines()
    if len(lines) != expected_lines:
        raise PackError(
            f"episode {match_id}: {what} has {len(lines)} lines but meta says frames={expected_lines}"
        )
    for i, line in enumerate(lines):
        if not line.strip():
            continue  # blank line = "no keys held this frame"; still counts as a frame
        try:
            json.loads(line)
        except json.JSONDecodeError as err:
            raise PackError(f"episode {match_id}: {what} line {i} is not valid JSON: {err}") from err


def load_episode(path: Path) -> Episode:
    """Validate one raw episode directory and return its metadata (raises PackError with context)."""
    match_id = path.name
    if "." in match_id:
        raise PackError(f"episode {match_id}: match_id must not contain '.'")
    if TRAILING_CHUNK_RE.match(match_id):
        raise PackError(f"episode {match_id}: match_id must not end with '_c<digits>'")

    meta = _load_meta(path, match_id)
    if "matchId" in meta and meta["matchId"] != match_id:
        raise PackError(f"episode {match_id}: meta.json matchId={meta['matchId']!r} != directory name")
    try:
        fps = float(meta["fps"])
        frames = int(meta["frames"])
        chunk_frames = [int(n) for n in meta["chunkFrames"]]
    except (KeyError, TypeError, ValueError) as err:
        raise PackError(
            f"episode {match_id}: meta.json missing/invalid fps|frames|chunkFrames: {err}"
        ) from err
    if fps <= 0 or frames <= 0 or not chunk_frames or any(n <= 0 for n in chunk_frames):
        raise PackError(f"episode {match_id}: fps/frames/chunkFrames must all be positive")
    if frames != sum(chunk_frames):
        raise PackError(f"episode {match_id}: meta frames={frames} != sum(chunkFrames)={sum(chunk_frames)}")

    for c in range(len(chunk_frames)):
        mp4 = path / f"chunk_{c:05d}.mp4"
        if not mp4.is_file():
            raise PackError(f"episode {match_id}: missing {mp4.name} (meta lists {len(chunk_frames)} chunks)")
    extra = sorted(p.name for p in path.glob("chunk_*.mp4"))
    extra = [n for n in extra if n not in {f"chunk_{c:05d}.mp4" for c in range(len(chunk_frames))}]
    if extra:
        print(f"[pack] warning: episode {match_id}: ignoring chunk files not in meta chunkFrames: {extra}")

    actions = path / "actions.jsonl"
    if not actions.is_file():
        raise PackError(f"episode {match_id}: missing actions.jsonl")
    _validate_jsonl(actions, match_id, frames, "actions.jsonl")

    physics = path / "physics.jsonl"
    if physics.is_file():
        _validate_jsonl(physics, match_id, frames, "physics.jsonl")

    return Episode(
        match_id=match_id,
        path=path,
        fps=fps,
        chunk_frames=chunk_frames,
        arena=_arena(meta),
        has_physics=physics.is_file(),
    )


def probe_frame_count(mp4: Path) -> int:
    """Exact decoded frame count of the first video stream, via ffprobe."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(mp4)],
        check=True, capture_output=True, text=True,
    )  # fmt: skip
    return int(out.stdout.strip())


def verify_chunk_frames(ep: Episode) -> None:
    """Check every chunk mp4 decodes to exactly its chunkFrames[c] frames (needs ffprobe)."""
    for c, want in enumerate(ep.chunk_frames):
        mp4 = ep.chunk_mp4(c)
        try:
            got = probe_frame_count(mp4)
        except (subprocess.CalledProcessError, ValueError) as err:
            raise PackError(f"episode {ep.match_id}: ffprobe failed on {mp4.name}: {err}") from err
        if got != want:
            raise PackError(
                f"episode {ep.match_id}: {mp4.name} has {got} frames but meta chunkFrames[{c}]={want}"
            )


# -- splitting & packing -----------------------------------------------------


def split_episodes(
    episodes: list[Episode], test_every: int, test_ids: list[str] | None
) -> tuple[list[Episode], list[Episode]]:
    """Split by episode: explicit `test_ids`, else every `test_every`-th (the 1st, N+1th, ...)."""
    if test_ids is not None:
        wanted = set(test_ids)
        known = {ep.match_id for ep in episodes}
        missing = sorted(wanted - known)
        if missing:
            raise PackError(f"--test-ids not found among episodes: {missing}")
        train = [ep for ep in episodes if ep.match_id not in wanted]
        test = [ep for ep in episodes if ep.match_id in wanted]
        return train, test
    if test_every < 1:
        raise PackError(f"--test-every must be >= 1, got {test_every}")
    train = [ep for i, ep in enumerate(episodes) if i % test_every != 0]
    test = [ep for i, ep in enumerate(episodes) if i % test_every == 0]
    return train, test


def _add_member(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    tar.addfile(info, io.BytesIO(data))


def _slice_lines(lines: list[bytes], chunk_frames: list[int], c: int) -> bytes:
    """The c-th chunk's slice of a whole-episode jsonl, exactly chunk_frames[c] lines."""
    start = sum(chunk_frames[:c])
    return b"".join(line + b"\n" for line in lines[start : start + chunk_frames[c]])


def _write_match(tar: tarfile.TarFile, ep: Episode) -> None:
    """Write all of one match's (match, chunk) samples; members of a sample stay contiguous."""
    action_lines = (ep.path / "actions.jsonl").read_bytes().splitlines()
    physics_lines = (ep.path / "physics.jsonl").read_bytes().splitlines() if ep.has_physics else None
    for c in range(len(ep.chunk_frames)):
        key = f"{ep.match_id}_c{c:05d}"
        _add_member(tar, f"{key}.p0.mp4", ep.chunk_mp4(c).read_bytes())
        _add_member(tar, f"{key}.p0.jsonl", _slice_lines(action_lines, ep.chunk_frames, c))
        if physics_lines is not None:
            _add_member(tar, f"{key}.p0.physics.jsonl", _slice_lines(physics_lines, ep.chunk_frames, c))


def _index_entry(ep: Episode, shard: str) -> dict:
    frames = ep.frames
    return {
        "match_id": ep.match_id,
        "shard": shard,
        "n_players": 1,
        "chunk_frames": list(ep.chunk_frames),
        "arena": ep.arena,
        "perspectives": [
            {
                "player_id": 0,
                "team": 0,
                "frames": frames,
                "duration": frames / ep.fps,  # source fps is DERIVED as frames / duration
                "recording_offset_sec": 0.0,
                "anchors": [],
            }
        ],
    }


def write_split(out: Path, episodes: list[Episode], matches_per_shard: int) -> tuple[int, int]:
    """Write one split directory (index.json + dataset_*.tar); returns (n_matches, n_shards)."""
    out.mkdir(parents=True, exist_ok=True)
    entries: list[dict] = []
    n_shards = 0
    for s, start in enumerate(range(0, len(episodes), matches_per_shard)):
        shard = f"dataset_{s:05d}.tar"
        group = episodes[start : start + matches_per_shard]
        with tarfile.open(out / shard, "w") as tar:  # uncompressed: random access needs plain "r"
            for ep in group:
                _write_match(tar, ep)
                entries.append(_index_entry(ep, shard))
        n_shards += 1
    index = {"total_samples": len(entries), "entries": entries}
    (out / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    return len(entries), n_shards


# -- CLI ----------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0], formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument("--episodes", type=Path, required=True, help="directory of raw episode subdirs")
    parser.add_argument("--out", type=Path, required=True, help="output dataset dir (gets train/ + test/)")
    parser.add_argument(
        "--test-every", type=int, default=10,
        help="every Nth episode (sorted by match_id; the 1st, N+1th, ...) goes to test",
    )  # fmt: skip
    parser.add_argument(
        "--test-ids", type=str, default=None,
        help="comma-separated match_ids to put in test (overrides --test-every)",
    )  # fmt: skip
    parser.add_argument("--matches-per-shard", type=int, default=8, help="matches per dataset_*.tar")
    parser.add_argument(
        "--verify-frames", action=argparse.BooleanOptionalAction, default=True,
        help="verify each chunk mp4's exact frame count with ffprobe",
    )  # fmt: skip
    args = parser.parse_args(argv)

    if args.matches_per_shard < 1:
        parser.error(f"--matches-per-shard must be >= 1, got {args.matches_per_shard}")

    episode_dirs = sorted((p for p in args.episodes.iterdir() if p.is_dir()), key=lambda p: p.name)
    if not episode_dirs:
        print(f"[pack] no episode directories found under {args.episodes}", file=sys.stderr)
        return 1

    verify = args.verify_frames
    if verify and shutil.which("ffprobe") is None:
        print("[pack] warning: ffprobe not on PATH; skipping per-chunk frame-count verification")
        verify = False

    try:
        episodes = []
        for d in episode_dirs:
            ep = load_episode(d)
            if verify:
                verify_chunk_frames(ep)
            episodes.append(ep)
        test_ids = [s for s in args.test_ids.split(",") if s] if args.test_ids is not None else None
        train, test = split_episodes(episodes, args.test_every, test_ids)
        for name, split in (("train", train), ("test", test)):
            if not split:
                print(f"[pack] warning: {name} split is empty")
            n, shards = write_split(args.out / name, split, args.matches_per_shard)
            chunks = sum(len(ep.chunk_frames) for ep in split)
            print(f"[pack] {name}: {n} matches, {chunks} chunks, {shards} shard(s) -> {args.out / name}")
    except PackError as err:
        print(f"[pack] error: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
