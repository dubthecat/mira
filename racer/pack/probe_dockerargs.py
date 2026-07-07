"""Empirically determine how RunPod parses dockerArgs (one-time diagnostic).

Launches two minimal pods on the cheapest available GPU, each with a
self-terminating payload expressed in a different quoting convention:

  A) shell-wrapped:  bash -c 'python3 -c "$TERM_PY"'   (works if RunPod wraps
     dockerArgs in sh -c)
  B) exec-form safe: python3 -c exec(__import__('os').environ['TERM_PY'])
     (no spaces in the -c argument: works if RunPod naively whitespace-splits)

Whichever pod self-terminates within ~5 min of container start reveals the
parsing world we're in. Costs a few cents.

Usage: RUNPOD_API_KEY=... python3 probe_dockerargs.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request

API = "https://api.runpod.io/graphql?api_key={key}"

TERM_PY = (
    "import os,json,urllib.request;"
    "pid=os.environ.get('RUNPOD_POD_ID','');"
    "q={'query':'mutation { podTerminate(input: {podId: \"'+pid+'\"}) }'};"
    "r=urllib.request.Request('https://api.runpod.io/graphql?api_key='"
    "+os.environ['RUNPOD_API_KEY'],data=json.dumps(q).encode(),"
    "headers={'content-type':'application/json'});"
    "print(urllib.request.urlopen(r).read()[:200])"
)

PROBES = {
    "quoted": "bash -c 'sleep 20; python3 -c \"$TERM_PY\"'",
    "noquote": "python3 -c exec(__import__('os').environ['TERM_PY'])",
}


def gql(key: str, query: str, variables: dict | None = None) -> dict:
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        API.format(key=key),
        data=body,
        headers={"content-type": "application/json", "user-agent": "curl/8.5.0"},
    )
    resp = json.loads(urllib.request.urlopen(req).read())
    if resp.get("errors"):
        raise RuntimeError(json.dumps(resp["errors"]))
    return resp["data"]


GPUS = [
    "NVIDIA GeForce RTX 4090",
    "NVIDIA RTX A6000",
    "NVIDIA L40",
    "NVIDIA L40S",
    "NVIDIA A100 80GB PCIe",
]


def main() -> int:
    key = os.environ["RUNPOD_API_KEY"]
    for name, docker_args in PROBES.items():
        deployed = False
        for gpu in GPUS:
            pod_input = {
                "cloudType": "COMMUNITY",
                "gpuCount": 1,
                "gpuTypeId": gpu,
                "name": f"probe-{name}",
                "imageName": "runpod/pytorch:1.0.7-cu1281-torch280-ubuntu2404",
                "dockerArgs": docker_args,
                "containerDiskInGb": 20,
                "volumeInGb": 0,
                "env": [
                    {"key": "TERM_PY", "value": TERM_PY},
                    {"key": "RUNPOD_API_KEY", "value": key},
                ],
            }
            try:
                data = gql(
                    key,
                    "mutation($input: PodFindAndDeployOnDemandInput) {"
                    " podFindAndDeployOnDemand(input: $input) { id costPerHr } }",
                    {"input": pod_input},
                )
                pod = data["podFindAndDeployOnDemand"]
                print(f"probe {name}: pod {pod['id']} on {gpu} @ ${pod['costPerHr']}/hr")
                deployed = True
                break
            except Exception as e:
                print(f"probe {name}: {gpu}: {e}", file=sys.stderr)
        if not deployed:
            print(f"probe {name}: deploy FAILED on all GPU types")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
