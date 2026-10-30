"""Preview ONNX export of a league policy (`bun run export` calls this once T25 wires it).

    scripts/py -m trainer.ppo.export --ckpt <ckpt or snapshot .pt> --out <dir>/model.onnx
    scripts/py -m trainer.ppo.export --run-dir <runs/fighter-league> --out <dir>/model.onnx   # latest Champion snapshot

The graph takes float32 (batch, obs) and returns one logits tensor per action dimension plus the value;
onnxruntime parity with torch is checked by export_onnx.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch

from ..export_onnx import export_onnx
from . import league as L
from .ppo import Agent
from .train_realtime import GAMES, agent_from_state, native_nvec, read_weights


class PolicyGraph(torch.nn.Module):
    def __init__(self, agent: Agent):
        super().__init__()
        self.agent = agent

    def forward(self, x: torch.Tensor):
        logits, value = self.agent(x)
        return (*torch.split(logits, list(self.agent.nvec), dim=-1), value)


def latest_champion(run_dir: Path) -> Path:
    snaps = sorted((run_dir / "league" / "A").glob("snap-A-*.pt"))
    if snaps:
        return snaps[-1]
    ckpts = sorted((run_dir / "ckpt" / "A").glob("ckpt-*.pt"))
    if not ckpts:
        raise FileNotFoundError(f"no Champion snapshot or checkpoint under {run_dir}")
    return ckpts[-1]


def export_policy(ckpt: Path, out: Path, game: str = "fighter") -> dict:
    # Exported as trained: a pre-R15 checkpoint keeps its heads and observation (the shipped runtime agent reads those).
    state = read_weights(ckpt)
    agent = agent_from_state(state, native_nvec(state, game)).eval()
    sample = torch.zeros(3, agent.obs_size)
    sha = export_onnx(PolicyGraph(agent), sample, out)
    return {"source": str(ckpt), "model": str(out), "sha256": sha, "obsSize": agent.obs_size, "nvec": list(agent.nvec)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt")
    ap.add_argument("--run-dir")
    ap.add_argument("--out", required=True)
    ap.add_argument("--game", default="fighter")
    a = ap.parse_args(argv)
    if bool(a.ckpt) == bool(a.run_dir):
        ap.error("pass exactly one of --ckpt and --run-dir")
    ckpt = Path(a.ckpt) if a.ckpt else latest_champion(Path(a.run_dir))
    print(json.dumps(export_policy(ckpt, Path(a.out), a.game), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
