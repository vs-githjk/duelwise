"""Dumps a league snapshot's weights as JSON (base64 float32, torch layout) and, when --obs is given, the torch logits on
the observations in that JSON file. Read-only on the snapshot. Feeds packages/agents/fixtures/puck-fixture.ts.

    scripts/py packages/agents/fixtures/puck-dump-weights.py --ckpt <snap.pt> --out weights.json [--obs obs.json --logits logits.json]
"""

from __future__ import annotations

import argparse
import base64
import json

import numpy as np
import torch

from trainer.ppo.train_realtime import agent_from_state, native_nvec, read_weights


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--obs")
    ap.add_argument("--logits")
    a = ap.parse_args()
    state = read_weights(a.ckpt)
    agent = agent_from_state(state, native_nvec(state, "puck")).eval()
    tensors = {}
    for name, t in agent.state_dict().items():
        arr = t.detach().cpu().numpy().astype(np.float32)
        tensors[name] = {"shape": list(arr.shape), "data": base64.b64encode(arr.tobytes()).decode()}
    with open(a.out, "w") as f:
        json.dump({"obs": agent.obs_size, "hidden": agent.hidden, "nvec": list(agent.nvec), "tensors": tensors}, f)
    if a.obs and a.logits:
        obs = np.array(json.load(open(a.obs))["obs"], dtype=np.float32)
        with torch.no_grad():
            logits, _ = agent(torch.from_numpy(obs))
        parts = torch.split(logits, list(agent.nvec), dim=-1)
        json.dump({"logits": [p.numpy().tolist() for p in parts]}, open(a.logits, "w"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
