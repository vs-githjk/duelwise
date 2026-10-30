"""One resumable, time-budgeted training loop shared by the chess policy and value trainers.

Checkpoints are atomic (trainer.checkpoint) and written every `checkpoint_seconds` (default 15 minutes) and at exit.
The elapsed training time is stored in the checkpoint, so a restarted job continues its budget instead of restarting it.
A SIGTERM stops the loop cleanly (checkpoint written, `done` false); reaching the time or step budget sets `done`."""

from __future__ import annotations

import json
import math
import signal
import time
from pathlib import Path
from typing import Callable

import torch

from ..checkpoint import load_latest, save_checkpoint
from ..jobs import heartbeat


def cosine_lr(base: float, frac: float, floor: float = 0.02) -> float:
    return base * (floor + (1 - floor) * 0.5 * (1 + math.cos(math.pi * min(max(frac, 0.0), 1.0))))


def train_timed(
    *,
    name: str,
    model: torch.nn.Module,
    opt: torch.optim.Optimizer,
    step_fn: Callable[[], dict],
    ckpt_dir: Path,
    budget_s: float,
    base_lr: float,
    arch: list[int],
    resume: bool,
    batch: int,
    checkpoint_seconds: float = 900.0,
    max_steps: int = 0,
    log_every_s: float = 30.0,
    metrics_path: Path | None = None,
    eval_fn: Callable[[], dict] | None = None,
    eval_every_s: float = 300.0,
) -> dict:
    """Runs `step_fn` (one optimizer step, returns scalar metrics) until `budget_s` seconds of training have accumulated
    (across restarts), or `max_steps` steps if given. Returns the summary row (also appended to metrics_path)."""
    step, prior = 0, 0.0
    if resume:
        info = load_latest(ckpt_dir, model, opt)
        if info is not None:
            step, prior = info["step"], float((info["extra"] or {}).get("elapsed_s", 0.0))
            print(f"{name}: resumed at step {step}, {prior:.0f}s of {budget_s:.0f}s", flush=True)
    stop = {"flag": False}
    old = signal.signal(signal.SIGTERM, lambda *_: stop.update(flag=True))
    start_step, t0 = step, time.monotonic()
    last_ckpt = last_log = last_eval = t0
    acc: dict[str, float] = {}
    acc_n = 0
    samples = 0
    elapsed = prior

    def finished() -> bool:
        return (max_steps > 0 and step >= max_steps) or (max_steps == 0 and elapsed >= budget_s)

    def save(done: bool) -> None:
        save_checkpoint(ckpt_dir, step, model, opt, extra={"elapsed_s": elapsed, "arch": arch, "done": done}, keep_last=3)

    def emit(row: dict) -> None:
        print(f"{name}: " + json.dumps(row), flush=True)
        if metrics_path is not None:
            metrics_path.parent.mkdir(parents=True, exist_ok=True)
            with open(metrics_path, "a") as f:
                f.write(json.dumps(row) + "\n")

    try:
        while not stop["flag"] and not finished():
            frac = (step / max_steps) if max_steps else (elapsed / budget_s)
            for g in opt.param_groups:
                g["lr"] = cosine_lr(base_lr, frac)
            m = step_fn()
            step += 1
            samples += batch
            acc_n += 1
            for k, v in m.items():
                acc[k] = acc.get(k, 0.0) + v
            now = time.monotonic()
            elapsed = prior + (now - t0)
            heartbeat()
            if now - last_ckpt >= checkpoint_seconds:
                save(False)
                last_ckpt = now
            if eval_fn is not None and now - last_eval >= eval_every_s:
                emit({"step": step, "elapsed_s": round(elapsed), **eval_fn()})
                last_eval = time.monotonic()
            if now - last_log >= log_every_s:
                emit({"step": step, "elapsed_s": round(elapsed), "lr": round(opt.param_groups[0]["lr"], 6),
                      **{k: round(v / acc_n, 5) for k, v in acc.items()}, "samples_per_s": round(samples / max(now - t0, 1e-9))})
                acc, acc_n, last_log = {}, 0, now
    finally:
        signal.signal(signal.SIGTERM, old)
        elapsed = prior + (time.monotonic() - t0)
        done = finished()
        if step > start_step or not (ckpt_dir.is_dir() and any(ckpt_dir.glob("ckpt-*.pt"))):
            save(done)
    summary = {"step": step, "elapsed_s": round(elapsed), "samples_per_s": round(samples / max(elapsed - prior, 1e-9)) if samples else 0,
               "done": done}
    if eval_fn is not None and done:
        summary.update(eval_fn())
    emit({"final": True, **summary})
    return summary
