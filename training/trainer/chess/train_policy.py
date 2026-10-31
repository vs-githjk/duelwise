"""Policy trainer: one ResNet 6x64 per rating bucket (b1100, b1500, b1900, and the fine-tuned expert tier b2200), human moves as
targets, legal-move masked cross-entropy. Runs on MPS when available (job `chess-policy`, cpuSlots 0, because the CPU work is only memmapped batch slicing).

    scripts/py -m trainer.chess.train_policy --max-minutes 25 [--resume]

Each bucket trains for --max-minutes (cosine learning rate over that budget), checkpoints every 15 minutes under
<ckpt-dir>/<bucket>/, and exports <run-dir>/export/<bucket>/policy.onnx when its budget is reached.

The expert tier (b2200, the human-like Hard persona) is a FINE-TUNE of an existing net on Lichess games where both players are 2200+:

    scripts/py -m trainer.chess.train_policy --buckets b2200 --init-from runs/chess-policy/ckpt/b1900 --lr 5e-4 --max-minutes 25 \\
        --human-dir data/human/chess/shards --human-share 0.3

--init-from loads the weights of the newest checkpoint there into a fresh run (ignored on --resume of a run that has its own checkpoint).
--human-dir mixes in the human's own moves from Duelwise matches, weighted, at most 30 percent of every batch (trainer.human) and fewer
when that would show a human record more than 3 times. <run-dir>/export/<bucket>/holdout.json compares the result with the starting net
on the held-out expert positions (the last 5 percent of the Lichess shards, never trained on)."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import numpy as np
import torch

from ..checkpoint import load_latest
from ..human import HumanShards, MixedSampler, MAX_HUMAN_SHARE, check_share
from ..jobs import heartbeat
from ..paths import common_root, resolve_runs_path, runs_dir
from .data import Shards, chess_cache_dir, decode_policy
from .export import export_policy
from .loop import train_timed
from .policy_net import PolicyNet, policy_loss, top1_accuracy

BUCKETS = ["b1100", "b1500", "b1900"]  # the default run; b2200 is a fine-tune and is named explicitly with --buckets


def common_path(p: str | Path) -> Path:
    """`runs/...` resolves under the common root's runs dir, other relative paths (data/human/...) under the common root, so a job spec
    behaves the same from any worktree. Absolute paths are used as given."""
    p = Path(p)
    if p.is_absolute():
        return p
    return resolve_runs_path(p, runs_dir()) if p.parts and p.parts[0] == "runs" else common_root() / p


def pick_device(name: str) -> torch.device:
    if name != "auto":
        return torch.device(name)
    return torch.device("mps") if torch.backends.mps.is_available() else torch.device("cpu")


def evaluate(model: PolicyNet, shards: Shards, device: torch.device, batch: int = 1024, max_batches: int = 20) -> dict:
    model.eval()
    loss = acc = n = 0.0
    with torch.no_grad():
        for i, rec in enumerate(shards.val_batches(batch)):
            if i >= max_batches:
                break
            b = {k: v.to(device) for k, v in decode_policy(rec).items()}
            logits = model(b["planes"])
            loss += policy_loss(logits, b["mask"], b["move"]).item() * len(rec)
            acc += top1_accuracy(logits, b["mask"], b["move"]) * len(rec)
            n += len(rec)
    model.train()
    return {"val_loss": round(loss / n, 5), "val_top1": round(acc / n, 5)}


def train_bucket(bucket: str, data_dir: Path, ckpt_dir: Path, run_dir: Path, a: argparse.Namespace, device: torch.device) -> dict:
    shards = Shards(data_dir / bucket, "policy")
    torch.manual_seed(a.seed)
    model = PolicyNet(a.blocks, a.channels).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    rng = np.random.default_rng(a.seed)
    baseline = None
    has_own_ckpt = (ckpt_dir / bucket).is_dir() and any((ckpt_dir / bucket).glob("ckpt-*.pt"))
    if a.init_from and not has_own_ckpt:
        info = load_latest(common_path(a.init_from), model)  # weights only: a fresh optimizer and learning rate schedule for the fine-tune
        if info is None:
            raise FileNotFoundError(f"--init-from {a.init_from}: no checkpoint there")
        print(f"chess-policy: {bucket}: starting from {info['path']} (step {info['step']})", flush=True)
        baseline = evaluate(model.to(device), shards, device, max_batches=a.eval_batches)
    human_dir = common_path(a.human_dir) if a.human_dir else None
    if human_dir is not None and not (human_dir / "index.json").exists():
        print(f"chess-policy: {bucket}: no human shards at {human_dir}; training on Lichess games only", flush=True)
        human_dir = None
    human = HumanShards(human_dir) if human_dir else None
    sampler = MixedSampler(shards, human, check_share(a.human_share if human else 0.0), rng, a.batch * (a.max_steps or a.expected_steps))
    if human:
        print(f"chess-policy: {bucket}: {human.n} human records, share {sampler.share:.4f} (cap {MAX_HUMAN_SHARE})", flush=True)
    model.train()

    def step() -> dict:
        b = {k: v.to(device) for k, v in decode_policy(sampler.sample(a.batch)).items()}
        logits = model(b["planes"])
        loss = policy_loss(logits, b["mask"], b["move"])
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        return {"loss": loss.item()}

    print(f"chess-policy: {bucket}: {shards.train_n} train / {shards.val_n} val positions, device {device}, "
          f"{sum(p.numel() for p in model.parameters())} params", flush=True)
    summary = train_timed(
        name=f"chess-policy[{bucket}]", model=model, opt=opt, step_fn=step, ckpt_dir=ckpt_dir / bucket,
        budget_s=a.max_minutes * 60, base_lr=a.lr, arch=model.arch(), resume=a.resume, batch=a.batch,
        checkpoint_seconds=a.checkpoint_seconds, max_steps=a.max_steps, metrics_path=run_dir / f"metrics-{bucket}.jsonl",
        eval_fn=lambda: evaluate(model, shards, device),
    )
    if summary["done"]:
        sha = export_policy(model, run_dir / "export" / bucket / "policy.onnx")
        print(f"chess-policy: {bucket}: exported sha256 {sha}", flush=True)
        if baseline is not None:
            final = evaluate(model.to(device), shards, device, max_batches=a.eval_batches)
            (run_dir / "export" / bucket / "holdout.json").write_text(json.dumps({
                "bucket": bucket, "initFrom": str(a.init_from), "baseline": baseline, "candidate": final, "valPositions": shards.val_n,
                "humanRecords": human.n if human else 0, "humanShare": sampler.share, "steps": summary["step"], "sha256": sha}, indent=2) + "\n")
    return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--ckpt-dir", default=os.environ.get("TRAINER_CKPT_DIR"))
    ap.add_argument("--run-dir", default=os.environ.get("TRAINER_RUN_DIR"))
    ap.add_argument("--data-dir", default=None, help="folder holding b1100 b1500 b1900 (default: data/cache/chess in the common root)")
    ap.add_argument("--buckets", nargs="+", default=BUCKETS)
    ap.add_argument("--init-from", default=None, help="checkpoint folder whose newest weights start the run (a fine-tune, e.g. runs/chess-policy/ckpt/b1900)")
    ap.add_argument("--human-dir", default=None, help="folder with weighted shards of human games (shard-*.bin, index.json, weights.bin)")
    ap.add_argument("--human-share", type=float, default=MAX_HUMAN_SHARE, help=f"share of each batch from human games, at most {MAX_HUMAN_SHARE}")
    ap.add_argument("--expected-steps", type=int, default=8000, help="steps the run is expected to take, only to keep human records from being repeated more than 3 times")
    ap.add_argument("--eval-batches", type=int, default=20)
    ap.add_argument("--max-minutes", type=float, default=25.0, help="training time per bucket")
    ap.add_argument("--max-steps", type=int, default=0, help="stop each bucket after this many steps (tests, smoke); 0 = use the time budget")
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--blocks", type=int, default=6)
    ap.add_argument("--channels", type=int, default=64)
    ap.add_argument("--checkpoint-seconds", type=float, default=900.0)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args(argv)
    torch.set_num_threads(a.threads)
    device = pick_device(a.device)
    run_dir = Path(a.run_dir) if a.run_dir else resolve_runs_path("runs/chess-policy", runs_dir())
    ckpt_dir = Path(a.ckpt_dir) if a.ckpt_dir else run_dir / "ckpt"
    data_dir = Path(a.data_dir) if a.data_dir else chess_cache_dir()
    run_dir.mkdir(parents=True, exist_ok=True)
    code = 0
    for bucket in a.buckets:
        try:
            heartbeat()
            summary = train_bucket(bucket, data_dir, ckpt_dir, run_dir, a, device)
        except Exception as e:
            print(f"chess-policy: {bucket}: stopping on {type(e).__name__}: {e}", flush=True)
            return 1
        if not summary["done"]:  # SIGTERM: leave the rest for the restart
            return 0
    return code


if __name__ == "__main__":
    raise SystemExit(main())
