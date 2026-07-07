"""Upload per-genre datasets (runs/multiverse/<genre>/dataset) to one HF repo.

Layout in the repo: <genre>/train/..., <genre>/test/..., <genre>/spec.json —
loadable via RocketScienceDataset.from_hub(repo, split="<genre>/train").

Usage: HF_TOKEN=... python3 upload_multiverse.py <multiverse_dir> <repo_id>
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> int:
    root = Path(sys.argv[1])
    repo = sys.argv[2]
    token = os.environ.get("HF_TOKEN")
    if not token:
        print("error: set HF_TOKEN", file=sys.stderr)
        return 2

    from huggingface_hub import HfApi

    api = HfApi(token=token)
    api.create_repo(repo, repo_type="dataset", private=True, exist_ok=True)
    for genre_dir in sorted(root.iterdir()):
        dataset = genre_dir / "dataset"
        if not (dataset / "train" / "index.json").is_file():
            print(f"skip {genre_dir.name}: no packed dataset")
            continue
        genre = genre_dir.name
        api.upload_folder(repo_id=repo, repo_type="dataset",
                          folder_path=str(dataset), path_in_repo=genre)
        spec = genre_dir / "spec.json"
        if spec.is_file():
            api.upload_file(path_or_fileobj=str(spec), path_in_repo=f"{genre}/spec.json",
                            repo_id=repo, repo_type="dataset")
        n = json.loads((dataset / "train" / "index.json").read_text())["total_samples"]
        print(f"uploaded {genre}: {n} train matches")
    print(f"done -> https://huggingface.co/datasets/{repo}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
