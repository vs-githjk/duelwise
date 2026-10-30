"""Machine-wide paths. Shared state (runs/, the venv, data/) lives in the common root,
the parent of `git rev-parse --git-common-dir`, never relative to a worktree."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

TRAINING_DIR = Path(__file__).resolve().parents[1]
CODE_WORKTREE = TRAINING_DIR.parent


def _git(args: list[str], cwd: Path) -> str | None:
    try:
        p = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else None


def common_root(start: Path | str | None = None) -> Path:
    """Main checkout of the repo containing `start` (default: the current directory, else this file)."""
    for base in ([Path(start)] if start else [Path.cwd(), CODE_WORKTREE]):
        out = _git(["rev-parse", "--path-format=absolute", "--git-common-dir"], base)
        if out:
            return Path(out).resolve().parent
    raise RuntimeError(f"not inside a git checkout: {start or Path.cwd()}")


def worktree_root(start: Path | str | None = None) -> Path:
    """Top level of the worktree containing `start` (default: the current directory, else this file)."""
    for base in ([Path(start)] if start else [Path.cwd(), CODE_WORKTREE]):
        out = _git(["rev-parse", "--show-toplevel"], base)
        if out:
            return Path(out).resolve()
    raise RuntimeError(f"not inside a git checkout: {start or Path.cwd()}")


def runs_dir(start: Path | str | None = None) -> Path:
    return common_root(start) / "runs"


def venv_dir(start: Path | str | None = None) -> Path:
    return common_root(start) / "training" / ".venv"


def resolve_runs_path(p: str | Path, runs: Path) -> Path:
    """Job specs write paths like `runs/<job>/ckpt`; those resolve under the common root's runs dir."""
    p = Path(p)
    if p.is_absolute():
        return p
    parts = p.parts
    if parts and parts[0] == "runs":
        return runs.joinpath(*parts[1:])
    return runs / p


def atomic_write_bytes(path: Path | str, data: bytes) -> None:
    """Write via a temp file in the same directory, fsync, then rename over the target."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
