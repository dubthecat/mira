"""Deploy the smoke-train pod on RunPod (cost-bounded, self-terminating).

Uses the REST API's exec-form `dockerStartCmd` ARRAY (POST /v1/pods), which
docker receives token-for-token. The GraphQL `dockerArgs` string is tokenized
by RunPod itself — NOT handed to a shell — so quoted `bash -c '...'` payloads
get mangled into invalid argv, the container dies instantly, and the pod
restart-loops while billing (observed: uptime bouncing 0-17s forever). Never
use dockerArgs for nontrivial commands.

Also load-bearing (from the OpenAPI spec, rest.runpod.io/v1/openapi.json):
- volumeInGb DEFAULTS TO 20 — must be set to 0 explicitly
- env is a plain {name: value} object (GraphQL wanted [{key, value}])
- replacing CMD means /start.sh never runs: no sshd/jupyter, headless only
- there is NO logs API: the script self-reports by uploading its log to HF,
  and self-terminates in an EXIT/TERM trap (DELETE /v1/pods/{id})

Usage:
    RUNPOD_API_KEY=... HF_TOKEN=... python3 deploy_smoke.py [--gpu ...]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

REST = "https://rest.runpod.io/v1"
RAW_SCRIPT = "https://raw.githubusercontent.com/dubthecat/mira/racer-pipeline/racer/pack/train_smoke.sh"

# One argv token each — the script element may contain anything.
def start_cmd() -> list[str]:
    boot = (
        "set -u; "
        f"(curl -fsSL {RAW_SCRIPT} -o /train_smoke.sh || "
        f"python3 -c \"import urllib.request;urllib.request.urlretrieve('{RAW_SCRIPT}','/train_smoke.sh')\"); "
        "timeout 7200 bash /train_smoke.sh; "
        # belt-and-braces: terminate even if the script's own trap failed
        'curl -s -X DELETE "https://rest.runpod.io/v1/pods/$RUNPOD_POD_ID" '
        '-H "Authorization: Bearer $RUNPOD_API_KEY"; '
        "sleep 5"
    )
    return ["bash", "-c", boot]


GPUS_DEFAULT = ["NVIDIA A100 80GB PCIe", "NVIDIA A100-SXM4-80GB", "NVIDIA H100 PCIe"]


def rest(key: str, method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        REST + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {key}",
            "user-agent": "curl/8.5.0",
        },
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or "{}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gpu", action="append", default=None, help="GPU type id (repeatable, tried in order)")
    parser.add_argument("--image", default="runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404")
    parser.add_argument("--repo", default="WilliamBolduc/racer-world-model-v1")
    parser.add_argument("--run-name", default="smoke1")
    parser.add_argument("--disk", type=int, default=80)
    parser.add_argument("--cloud", default="SECURE", choices=["SECURE", "COMMUNITY"])
    args = parser.parse_args()

    key = os.environ.get("RUNPOD_API_KEY")
    hf = os.environ.get("HF_TOKEN")
    if not key or not hf:
        print("error: set RUNPOD_API_KEY and HF_TOKEN", file=sys.stderr)
        return 2

    body_base = {
        "name": f"racer-{args.run_name}",
        "imageName": args.image,
        # SECURE = datacenter fleet: pricier than community but image pulls
        # actually complete (two community hosts sat in pull-limbo for hours)
        "cloudType": args.cloud,
        "computeType": "GPU",
        "gpuCount": 1,
        "interruptible": False,
        "containerDiskInGb": args.disk,
        "volumeInGb": 0,  # explicit: REST default silently attaches 20GB
        "env": {
            "HF_TOKEN": hf,
            "HF_DATASET_REPO": args.repo,
            "GIT_REPO": "https://github.com/dubthecat/mira",
            "GIT_BRANCH": "racer-pipeline",
            "RUNPOD_API_KEY": key,
            "RUN_NAME": args.run_name,
        },
        "dockerEntrypoint": [],
        "dockerStartCmd": start_cmd(),
    }
    for gpu in args.gpu or GPUS_DEFAULT:
        try:
            pod = rest(key, "POST", "/pods", {**body_base, "gpuTypeIds": [gpu]})
            print(json.dumps({k: pod.get(k) for k in ("id", "imageName", "costPerHr", "machineId")}, indent=2))
            print(f"\npod {pod['id']} on {gpu} — logs will land in "
                  f"hf://{args.repo}/runs/{args.run_name}/ (script self-reports; no logs API exists)")
            return 0
        except urllib.error.HTTPError as e:
            print(f"{gpu}: HTTP {e.code} {e.read()[:200]}", file=sys.stderr)
        except Exception as e:
            print(f"{gpu}: {e}", file=sys.stderr)
    print("error: no GPU type could be deployed", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
