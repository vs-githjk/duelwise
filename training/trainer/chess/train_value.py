"""Value trainer: 768 -> 256 -> 32 -> 1 clipped-ReLU net on the Lichess evaluation positions (mover's expected score).
Runs on one CPU slot (job `chess-value`), about 20 minutes.

    scripts/py -m trainer.chess.train_value --max-minutes 20 [--resume]

Checkpoints every 15 minutes in <ckpt-dir>; at the end writes <run-dir>/export/{value.onnx,value.bin} (see export.py)."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from ..jobs import heartbeat
from ..paths import resolve_runs_path, runs_dir
from .data import Shards, chess_cache_dir, decode_value
from .export import export_value
from .loop import train_timed
from .value_net import ValueNet


def evaluate(model: ValueNet, shards: Shards, batch: int = 8192, max_batches: int = 3) -> dict:
    model.eval()
    se = n = 0.0
    with torch.no_grad():
        for i, rec in enumerate(shards.val_batches(batch)):
            if i >= max_batches:
                break
            x, t = decode_value(rec)
            se += F.mse_loss(model(x), t, reduction="sum").item()
            n += len(rec)
    model.train()
    return {"val_mse": round(se / n, 6)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--ckpt-dir", default=os.environ.get("TRAINER_CKPT_DIR"))
    ap.add_argument("--run-dir", default=os.environ.get("TRAINER_RUN_DIR"))
    ap.add_argument("--data-dir", default=None, help="folder holding value/ (default: data/cache/chess in the common root)")
    ap.add_argument("--max-minutes", type=float, default=20.0)
    ap.add_argument("--max-steps", type=int, default=0)
    ap.add_argument("--batch", type=int, default=4096)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--h1", type=int, default=256)
    ap.add_argument("--h2", type=int, default=32)
    ap.add_argument("--checkpoint-seconds", type=float, default=900.0)
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args(argv)
    torch.set_num_threads(a.threads)
    run_dir = Path(a.run_dir) if a.run_dir else resolve_runs_path("runs/chess-value", runs_dir())
    ckpt_dir = Path(a.ckpt_dir) if a.ckpt_dir else run_dir / "ckpt"
    data_dir = Path(a.data_dir) if a.data_dir else chess_cache_dir()
    run_dir.mkdir(parents=True, exist_ok=True)
    try:
        shards = Shards(data_dir / "value", "value")
        torch.manual_seed(a.seed)
        model = ValueNet(a.h1, a.h2)
        opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.0)
        rng = np.random.default_rng(a.seed)
        print(f"chess-value: {shards.train_n} train / {shards.val_n} val positions, {sum(p.numel() for p in model.parameters())} params", flush=True)

        def step() -> dict:
            x, t = decode_value(shards.sample(rng, a.batch))
            loss = F.binary_cross_entropy_with_logits(model.logit(x), t)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            return {"loss": loss.item()}

        heartbeat()
        summary = train_timed(
            name="chess-value", model=model, opt=opt, step_fn=step, ckpt_dir=ckpt_dir, budget_s=a.max_minutes * 60, base_lr=a.lr,
            arch=model.arch(), resume=a.resume, batch=a.batch, checkpoint_seconds=a.checkpoint_seconds, max_steps=a.max_steps,
            metrics_path=run_dir / "metrics.jsonl", eval_fn=lambda: evaluate(model, shards),
        )
        if summary["done"]:
            sha = export_value(model, run_dir / "export" / "value.onnx", run_dir / "export" / "value.bin")
            print(f"chess-value: exported sha256 {sha}", flush=True)
    except Exception as e:
        print(f"chess-value: stopping on {type(e).__name__}: {e}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
