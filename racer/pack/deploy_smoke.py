"""Deploy the smoke-train pod on RunPod (cost-bounded, self-terminating).

Usage:
    RUNPOD_API_KEY=... HF_TOKEN=... python3 deploy_smoke.py [--gpu "NVIDIA A100 80GB PCIe"]

The pod fetches racer/pack/train_smoke.sh from the public GitHub branch and
runs it under `timeout 7200`; the script self-terminates the pod on any exit,
and a fallback terminate runs after the timeout, so worst-case spend is
~2h * community price.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

API = "https://api.runpod.io/graphql?api_key={key}"
RAW_SCRIPT = "https://raw.githubusercontent.com/dubthecat/mira/racer-pipeline/racer/pack/train_smoke.sh"

FETCH_PY = f"import urllib.request;urllib.request.urlretrieve('{RAW_SCRIPT}','/train_smoke.sh')"
TERMINATE_PY = (
    "import os,json,urllib.request;"
    "pid=os.environ.get('RUNPOD_POD_ID','');"
    "q={'query':'mutation { podTerminate(input: {podId: \"'+pid+'\"}) }'};"
    "r=urllib.request.Request('https://api.runpod.io/graphql?api_key='"
    "+os.environ['RUNPOD_API_KEY'],data=json.dumps(q).encode(),"
    "headers={'content-type':'application/json'});"
    "print(urllib.request.urlopen(r).read()[:200])"
)
DOCKER_ARGS = (
    "bash -c 'python3 -c \"$FETCH_PY\" && timeout 7200 bash /train_smoke.sh; "
    "python3 -c \"$TERMINATE_PY\"'"
)


def gql(key: str, query: str, variables: dict | None = None) -> dict:
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        API.format(key=key), data=body, headers={"content-type": "application/json"}
    )
    resp = json.loads(urllib.request.urlopen(req).read())
    if resp.get("errors"):
        raise RuntimeError(json.dumps(resp["errors"]))
    return resp["data"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gpu", default="NVIDIA A100 80GB PCIe")
    parser.add_argument("--image", default="pytorch/pytorch:2.8.0-cuda12.8-cudnn9-devel")
    parser.add_argument("--repo", default="WilliamBolduc/racer-world-model-v1")
    parser.add_argument("--run-name", default="smoke1")
    args = parser.parse_args()

    key = os.environ.get("RUNPOD_API_KEY")
    hf = os.environ.get("HF_TOKEN")
    if not key or not hf:
        print("error: set RUNPOD_API_KEY and HF_TOKEN", file=sys.stderr)
        return 2

    env = [
        {"key": "HF_TOKEN", "value": hf},
        {"key": "HF_DATASET_REPO", "value": args.repo},
        {"key": "GIT_REPO", "value": "https://github.com/dubthecat/mira"},
        {"key": "GIT_BRANCH", "value": "racer-pipeline"},
        {"key": "RUNPOD_API_KEY", "value": key},
        {"key": "RUN_NAME", "value": args.run_name},
        {"key": "FETCH_PY", "value": FETCH_PY},
        {"key": "TERMINATE_PY", "value": TERMINATE_PY},
    ]
    pod_input = {
        "cloudType": "COMMUNITY",
        "gpuCount": 1,
        "gpuTypeId": args.gpu,
        "name": f"racer-{args.run_name}",
        "imageName": args.image,
        "dockerArgs": DOCKER_ARGS,
        "containerDiskInGb": 80,
        "volumeInGb": 0,
        "minVcpuCount": 8,
        "minMemoryInGb": 48,
        "env": env,
    }
    data = gql(
        key,
        "mutation($input: PodFindAndDeployOnDemandInput) {"
        " podFindAndDeployOnDemand(input: $input) { id imageName machineId costPerHr } }",
        {"input": pod_input},
    )
    pod = data["podFindAndDeployOnDemand"]
    print(json.dumps(pod, indent=2))
    print(f"\npod {pod['id']} deployed at ${pod.get('costPerHr', '?')}/hr — "
          f"logs land in hf://{args.repo}/runs/{args.run_name}/ when it finishes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
