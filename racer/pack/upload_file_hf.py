"""Upload individual files to the HF dataset repo (companion to upload_hf.py).

Usage:
    HF_TOKEN=... python3 upload_file_hf.py <repo_id> <local_path>:<path_in_repo> [...]
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    token = os.environ.get("HF_TOKEN")
    if not token:
        print("error: set HF_TOKEN", file=sys.stderr)
        return 2
    from huggingface_hub import HfApi

    api = HfApi(token=token)
    repo_id = sys.argv[1]
    for pair in sys.argv[2:]:
        local, _, remote = pair.partition(":")
        api.upload_file(path_or_fileobj=local, path_in_repo=remote,
                        repo_id=repo_id, repo_type="dataset")
        print(f"uploaded {local} -> {remote}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
