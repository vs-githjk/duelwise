"""Behaviour-cloning warm start for the arena (T10 fix round).

A policy that has never landed a shot learns from sparse rewards very slowly with nine action heads, so the
smoke (15 minutes) and the league's first stage start from a copy of the scripted bots: the Bun side plays the
rusher and holder through the real env (packages/core/src/games/arena/bc-data.ts) and this module fits the
trunk and the nine heads to their choices with cross-entropy. PPO then improves on that start. No new dependencies.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from ..bridge import find_bun
from ..paths import worktree_root
from .ppo import Agent


def collect(decisions: int, *, seed: int = 5, level: str = "champion@close", teachers: str = "rusher", out: Path | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Runs the Bun collector and returns (obs float32 [N, F], heads int64 [N, dims])."""
    root = worktree_root(Path(__file__).resolve().parent)
    script = root / "packages" / "core" / "src" / "games" / "arena" / "bc-data.ts"
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(out) if out else Path(tmp)
        cmd = [find_bun(), str(script), "--out", str(d), "--decisions", str(decisions), "--seed", str(seed), "--level", level, "--teachers", teachers]
        r = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"bc-data failed: {r.stderr[-1500:]}")
        meta = json.loads((d / "meta.json").read_text())
        obs = np.fromfile(d / "obs.f32", dtype=np.float32).reshape(meta["rows"], meta["obsFeatures"])
        act = np.fromfile(d / "act.u8", dtype=np.uint8).reshape(meta["rows"], meta["actionDims"]).astype(np.int64)
    return obs, act


def fit(agent: Agent, obs: np.ndarray, act: np.ndarray, *, epochs: int = 8, batch: int = 1024, lr: float = 1e-3, seed: int = 0, log=None) -> float:
    """Cross-entropy on every head (the mean over heads); returns the final epoch's mean loss."""
    g = torch.Generator().manual_seed(seed)
    x = torch.from_numpy(obs)
    y = torch.from_numpy(act)
    opt = torch.optim.Adam(list(agent.trunk.parameters()) + list(agent.actor.parameters()), lr=lr)
    n = x.shape[0]
    last = float("nan")
    for ep in range(epochs):
        perm = torch.randperm(n, generator=g)
        tot, cnt = 0.0, 0
        for s in range(0, n, batch):
            idx = perm[s : s + batch]
            logits = agent.actor(agent.trunk(x[idx]))
            loss = sum(F.cross_entropy(l, y[idx, i]) for i, l in enumerate(torch.split(logits, list(agent.nvec), dim=-1))) / len(agent.nvec)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            tot += float(loss.detach())
            cnt += 1
        last = tot / max(cnt, 1)
        if log:
            log(f"bc epoch {ep + 1}/{epochs} loss {last:.4f}")
    return last


def warm_start(agent: Agent, decisions: int, *, seed: int = 5, teachers: str = "rusher", epochs: int = 8, log=None) -> float:
    """Half the decisions from close-range starts, half from the normal start (the policy must also learn to find the fight)."""
    t0 = time.time()
    half = decisions // 2
    o1, a1 = collect(half, seed=seed, level="champion@close", teachers=teachers)
    o2, a2 = collect(decisions - half, seed=seed + 72, level="champion", teachers=teachers)
    obs, act = np.concatenate([o1, o2]), np.concatenate([a1, a2])
    if log:
        log(f"bc data: {len(obs):,} decisions in {time.time() - t0:.0f} s")
    return fit(agent, obs, act, epochs=epochs, seed=seed, log=log)
