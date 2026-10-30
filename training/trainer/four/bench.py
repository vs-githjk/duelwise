"""Self-play throughput benchmark for Four in a Row (T12b).

Plays the same number of games with the same network and the same simulations twice:
  baseline  one self-play host, no evaluation cache or sharing, torch on 2 threads (how T12 ran four-az)
  improved  `workers` hosts at once, cache and shared rows on, torch on one thread per worker (how four-az runs now)
and writes games per hour for both and their ratio. Run it from the worktree:
    scripts/py -m trainer.four.bench --games 128 --parallel 256 --out <absolute path>/T12b.json
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import torch

from .train import FourTrainer


def _trainer(blocks: int, channels: int, ckpt: Path | None) -> tuple[FourTrainer, str]:
    tr = FourTrainer(blocks, channels, seed=0)
    if ckpt is not None and tr.resume(ckpt, load_buffer=False):
        return tr, f"checkpoint step {tr.steps}"
    return tr, "random init (seed 0)"


def measure(tr: FourTrainer, games: int, parallel: int, sims: int, workers: int, cache: bool, threads: int, seed: int) -> dict:
    torch.set_num_threads(threads)
    extra = [] if cache else ["--cache", "0"]
    evals0, t0 = tr.evals, time.monotonic()
    done = tr.selfplay(games, parallel, sims, seed, extra=extra, workers=workers)
    dt = time.monotonic() - t0
    return {
        "games": len(done), "seconds": round(dt, 1), "games_per_hour": round(len(done) / dt * 3600),
        "network_evals": tr.evals - evals0, "plies": sum(len(g["moves"]) for g in done),
        "workers": workers, "cache": cache, "torch_threads": threads, "parallel": parallel,
    }


def run(games: int, parallel: int, sims: int, workers: int, blocks: int = 5, channels: int = 64,
        ckpt: Path | None = None, seed: int = 11) -> dict:
    tr, net = _trainer(blocks, channels, ckpt)
    base = measure(tr, games, parallel, sims, 1, False, 2, seed)
    new = measure(tr, games, parallel, sims, workers, True, 1, seed)
    return {
        "task": "T12b", "net": f"{blocks}x{channels}, {net}", "sims": sims, "loadavg": [round(x, 1) for x in os.getloadavg()],
        "baseline": base, "improved": new,
        "ratio": round(new["games_per_hour"] / max(base["games_per_hour"], 1), 2),
        "evals_per_ply": {"baseline": round(base["network_evals"] / max(base["plies"], 1), 1),
                          "improved": round(new["network_evals"] / max(new["plies"], 1), 1)},
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=128)
    ap.add_argument("--parallel", type=int, default=256, help="games in flight in total, as four-az runs (256)")
    ap.add_argument("--sims", type=int, default=200)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--blocks", type=int, default=5)
    ap.add_argument("--channels", type=int, default=64)
    ap.add_argument("--ckpt-dir", default=None, help="load weights from this checkpoint directory (read only)")
    ap.add_argument("--out", default=None)
    a = ap.parse_args(argv)
    ckpt = Path(a.ckpt_dir) if a.ckpt_dir else None
    row = run(a.games, a.parallel, a.sims, a.workers, a.blocks, a.channels, ckpt)
    print(json.dumps(row, indent=2))
    if a.out:
        Path(a.out).write_text(json.dumps(row, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
