"""Atomic, resumable checkpoints: ckpt-<step>.pt, written to a temp file and renamed."""

from __future__ import annotations

import io
import logging
import re
from pathlib import Path
from typing import Any

import torch

from .paths import atomic_write_bytes

_NAME = re.compile(r"^ckpt-(\d{10})\.pt$")
log = logging.getLogger(__name__)


class CheckpointMismatch(RuntimeError):
    """A readable checkpoint does not fit the model or optimizer (architecture changed)."""


def _name(step: int) -> str:
    if step < 0 or step > 9_999_999_999:
        raise ValueError(f"step out of range: {step}")
    return f"ckpt-{step:010d}.pt"


def save_checkpoint(
    ckpt_dir: Path | str,
    step: int,
    model: torch.nn.Module | None = None,
    optimizer: torch.optim.Optimizer | None = None,
    extra: dict[str, Any] | None = None,
    keep_last: int | None = None,
) -> Path:
    """Write ckpt-<step>.pt atomically. A kill at any point leaves either the old files or the new
    one, never a partial ckpt-*.pt (partial data only ever lives in a .tmp-* file).
    keep_last prunes older ckpt-*.pt files in this directory after the new one is in place."""
    ckpt_dir = Path(ckpt_dir)
    payload = {
        "step": int(step),
        "model": model.state_dict() if model is not None else None,
        "optimizer": optimizer.state_dict() if optimizer is not None else None,
        "extra": extra,
    }
    buf = io.BytesIO()
    torch.save(payload, buf)
    path = ckpt_dir / _name(step)
    atomic_write_bytes(path, buf.getvalue())
    if keep_last is not None:
        # Only files at or below the step just written are candidates; higher steps are never pruned.
        mine = sorted(p for p in ckpt_dir.iterdir() if _NAME.match(p.name) and p.name <= path.name)
        old = mine[:-max(keep_last, 1)]
        for p in old:
            p.unlink(missing_ok=True)
    return path


def load_latest(
    ckpt_dir: Path | str,
    model: torch.nn.Module | None = None,
    optimizer: torch.optim.Optimizer | None = None,
    map_location: str = "cpu",
) -> dict[str, Any] | None:
    """Load the newest readable checkpoint into model and optimizer. Returns {step, extra, path}
    or None when there is nothing to resume. An unreadable newest file falls back to the one before."""
    ckpt_dir = Path(ckpt_dir)
    if not ckpt_dir.is_dir():
        return None
    for p in sorted((p for p in ckpt_dir.iterdir() if _NAME.match(p.name)), reverse=True):
        try:
            data = torch.load(p, map_location=map_location, weights_only=False)
            state, opt_state = data["model"], data["optimizer"]
            step, extra = int(data["step"]), data["extra"]
        except Exception as e:
            log.warning("skipping corrupt checkpoint %s: %s: %s", p, type(e).__name__, e)
            continue
        if model is not None and state is not None:
            try:
                model.load_state_dict(state)
            except (RuntimeError, ValueError) as e:
                raise CheckpointMismatch(f"{p} does not fit the model: {_first_mismatch(model, state)}") from e
        if optimizer is not None and opt_state is not None:
            try:
                optimizer.load_state_dict(opt_state)
            except (RuntimeError, ValueError, KeyError) as e:
                raise CheckpointMismatch(f"{p} does not fit the optimizer: {e}") from e
        return {"step": step, "extra": extra, "path": p}
    return None


def _first_mismatch(model: torch.nn.Module, state: dict) -> str:
    own = model.state_dict()
    for k in own:
        if k not in state:
            return f"missing key {k!r} in checkpoint"
        if tuple(own[k].shape) != tuple(state[k].shape):
            return f"key {k!r}: checkpoint shape {tuple(state[k].shape)} vs model {tuple(own[k].shape)}"
    for k in state:
        if k not in own:
            return f"unexpected key {k!r} in checkpoint"
    return "unknown mismatch"
