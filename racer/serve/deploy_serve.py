"""Deploy the NEURAL PLAY serving pod on RunPod (cost-bounded, self-terminating).

Same load-bearing conventions as racer/pack/deploy_smoke.py (verified there the
hard way):

- REST API exec-form `dockerStartCmd` ARRAY (POST /v1/pods): docker receives it
  token-for-token. The GraphQL `dockerArgs` string is tokenized by RunPod itself
  — NOT handed to a shell — so quoted `bash -c '...'` payloads get mangled and
  the pod restart-loops while billing. Never use dockerArgs.
- volumeInGb DEFAULTS TO 20 — must be set to 0 explicitly.
- env is a plain {name: value} object.
- replacing CMD means /start.sh never runs: no sshd/jupyter, headless only.
- there is NO logs API: serve_pod.sh self-reports (STARTED.txt beacon with the
  ws:// endpoint + log upload to HF) and self-terminates in an EXIT/TERM trap
  (DELETE /v1/pods/{id}). The server itself exits after --idle-exit seconds
  (default 900) with no sessions, so an abandoned pod terminates itself.
- the terminate key env var must be RUNPOD_TERMINATE_KEY, NOT RUNPOD_API_KEY
  (RunPod injects its own pod-scoped key under that name, which can't delete pods).

Serving-specific: `"ports": ["8765/tcp"]` exposes a raw TCP port. RunPod maps it
to a random public port on the host: GET /v1/pods/{id} returns `publicIp` and
`portMappings` (e.g. {"8765": 30123}), both null while the pod is initializing.
The websocket endpoint is  ws://{publicIp}:{portMappings["8765"]}  — this script
polls for it and prints it; the pod also self-reports the same URL in its
STARTED.txt beacon (from RUNPOD_PUBLIC_IP / RUNPOD_TCP_PORT_8765).

Usage (DO NOT run without a reason to spend money):
    # full stack check with no checkpoint (fake frames):
    RUNPOD_API_KEY=... HF_TOKEN=... python3 deploy_serve.py --fake
    # real serving, once a trained checkpoint bundle is uploaded:
    RUNPOD_API_KEY=... HF_TOKEN=... python3 deploy_serve.py \\
        --ckpt-prefix runs/train1/serve [--gpu "NVIDIA A100 80GB PCIe"]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request

REST = "https://rest.runpod.io/v1"
RAW_SCRIPT = "https://raw.githubusercontent.com/dubthecat/mira/racer-pipeline/racer/serve/serve_pod.sh"


# One argv token each — the script element may contain anything.
def start_cmd() -> list[str]:
    boot = (
        "set -u; "
        f"(curl -fsSL {RAW_SCRIPT} -o /serve_pod.sh || "
        f"python3 -c \"import urllib.request;urllib.request.urlretrieve('{RAW_SCRIPT}','/serve_pod.sh')\"); "
        "bash /serve_pod.sh; "
        # belt-and-braces: terminate even if the script's own trap failed
        'curl -s -X DELETE "https://rest.runpod.io/v1/pods/$RUNPOD_POD_ID" '
        '-H "Authorization: Bearer $RUNPOD_TERMINATE_KEY"; '
        "sleep 5"
    )
    return ["bash", "-c", boot]


# A6000: cheapest 48GB card on SECURE (~$0.49/hr) — plenty for 1-2 serving
# sessions of the 1B model; step up with --gpu if it can't hold 20 fps.
GPUS_DEFAULT = ["NVIDIA RTX A6000"]


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


def wait_for_endpoint(key: str, pod_id: str, port: int, timeout_s: int) -> str | None:
    """Poll GET /v1/pods/{id} until publicIp + portMappings surface; return ws:// URL."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            pod = rest(key, "GET", f"/pods/{pod_id}")
        except Exception as e:
            print(f"  poll error (retrying): {e}", file=sys.stderr)
            pod = {}
        ip = pod.get("publicIp")
        mapping = pod.get("portMappings") or {}
        ext = mapping.get(str(port)) or mapping.get(port)
        status = pod.get("desiredStatus") or pod.get("lastStatusChange") or "?"
        if ip and ext:
            return f"ws://{ip}:{ext}"
        print(f"  waiting for port mapping... (status={status})")
        time.sleep(10)
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gpu", action="append", default=None, help="GPU type id (repeatable, tried in order)")
    parser.add_argument("--image", default="runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404")
    parser.add_argument("--repo", default="WilliamBolduc/racer-world-model-v1",
                        help="HF dataset repo: beacon/logs land in runs/<run-name>/; also the checkpoint + context source")
    parser.add_argument("--run-name", default="serve1")
    parser.add_argument("--fake", action="store_true",
                        help="no checkpoint: serve procedural frames (verifies pod networking + protocol)")
    parser.add_argument("--ckpt-prefix", default=None,
                        help="real mode: prefix inside --repo holding world_model_config.yaml + "
                             "checkpoint.pth (+ codec ckpt) [+ context.pt], e.g. runs/train1/serve")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--idle-exit", type=int, default=900,
                        help="server exits after N s with no sessions -> pod self-terminates")
    parser.add_argument("--max-sessions", type=int, default=2)
    parser.add_argument("--serve-extra", default="", help="extra serve_wm.py args (e.g. '--n-diffusion-steps 8')")
    parser.add_argument("--disk", type=int, default=60)
    parser.add_argument("--cloud", default="SECURE", choices=["SECURE", "COMMUNITY"])
    parser.add_argument("--wait", type=int, default=900,
                        help="seconds to poll for the public ws:// endpoint (0 = don't wait)")
    args = parser.parse_args()

    if not args.fake and not args.ckpt_prefix:
        print("error: pass --ckpt-prefix (real mode) or --fake (stack check)", file=sys.stderr)
        return 2
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
        "ports": [f"{args.port}/tcp"],  # raw TCP; surfaces as publicIp + portMappings
        "env": {
            "HF_TOKEN": hf,
            "HF_DATASET_REPO": args.repo,
            "GIT_REPO": "https://github.com/dubthecat/mira",
            "GIT_BRANCH": "racer-pipeline",
            # NOT "RUNPOD_API_KEY": RunPod injects its own pod-scoped key under
            # that name (cannot delete pods), which would shadow ours
            "RUNPOD_TERMINATE_KEY": key,
            "RUN_NAME": args.run_name,
            "SERVE_FAKE": "1" if args.fake else "0",
            "CKPT_PREFIX": args.ckpt_prefix or "",
            "PORT": str(args.port),
            "IDLE_EXIT": str(args.idle_exit),
            "MAX_SESSIONS": str(args.max_sessions),
            "SERVE_EXTRA": args.serve_extra,
        },
        "dockerEntrypoint": [],
        "dockerStartCmd": start_cmd(),
    }
    for gpu in args.gpu or GPUS_DEFAULT:
        try:
            pod = rest(key, "POST", "/pods", {**body_base, "gpuTypeIds": [gpu]})
        except urllib.error.HTTPError as e:
            print(f"{gpu}: HTTP {e.code} {e.read()[:200]}", file=sys.stderr)
            continue
        except Exception as e:
            print(f"{gpu}: {e}", file=sys.stderr)
            continue
        print(json.dumps({k: pod.get(k) for k in ("id", "imageName", "costPerHr", "machineId")}, indent=2))
        pod_id = pod["id"]
        print(f"\npod {pod_id} on {gpu} — beacon + logs land in hf://{args.repo}/runs/{args.run_name}/ "
              f"(script self-reports; no logs API exists)")
        if args.wait > 0:
            print(f"polling for the public endpoint (mapping appears once the container is scheduled;"
                  f" the SERVER inside is ready when STARTED.txt shows up on HF):")
            url = wait_for_endpoint(key, pod_id, args.port, args.wait)
            if url:
                print(f"\nwebsocket endpoint: {url}")
                print(f"verify:  racer/pack/.venv/bin/python racer/serve/test_client.py --url {url} --n 100")
                print(f"browser: NEXT_PUBLIC_NEURAL_WS_URL={url}")
            else:
                print("\nno mapping yet — look it up later with:")
                print(f'  curl -s {REST}/pods/{pod_id} -H "Authorization: Bearer $RUNPOD_API_KEY" '
                      f"| python3 -c \"import json,sys; p=json.load(sys.stdin); "
                      f"print('ws://%s:%s' % (p.get('publicIp'), (p.get('portMappings') or {{}}).get('{args.port}')))\"")
        return 0
    print("error: no GPU type could be deployed", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
