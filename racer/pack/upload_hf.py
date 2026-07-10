"""Upload a packed dataset (train/ + test/ split dirs) to the HuggingFace Hub.

The split directories map to hub path prefixes, which is exactly what
`RocketScienceDataset.from_hub(repo, split=...)` expects (DATASET_CONTRACT.md §1.1).

Usage:
    HF_TOKEN=... python3 upload_hf.py /path/to/dataset <user>/<repo> [--public]

Requires: pip install huggingface_hub (present in racer/pack/.venv).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset_dir", type=Path, help="dir containing train/ and test/")
    parser.add_argument("repo_id", help="hub dataset repo, e.g. user/racer-world-model-v1")
    parser.add_argument("--public", action="store_true", help="create as public (default private)")
    args = parser.parse_args()

    token = os.environ.get("HF_TOKEN")
    if not token:
        print("error: set HF_TOKEN (see racer/.env.local)", file=sys.stderr)
        return 2
    for split in ("train", "test"):
        if not (args.dataset_dir / split / "index.json").is_file():
            print(f"error: {args.dataset_dir}/{split}/index.json missing — pack first", file=sys.stderr)
            return 2

    from huggingface_hub import HfApi

    api = HfApi(token=token)
    api.create_repo(args.repo_id, repo_type="dataset", private=not args.public, exist_ok=True)
    url = api.upload_folder(
        repo_id=args.repo_id,
        repo_type="dataset",
        folder_path=str(args.dataset_dir),
        commit_message=f"upload {args.dataset_dir.name}",
    )
    print(f"uploaded -> https://huggingface.co/datasets/{args.repo_id}")
    print(f"commit: {url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
