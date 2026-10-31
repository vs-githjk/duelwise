"""Runs the human match export (apps/web/scripts/export-human.ts) and the poker profile build, from the app checkout.

DATABASE_URL is read from the environment by the Bun script; this module never reads, prints or logs it, and scrubs it from any error
text. The export is read only (the script runs every statement in a READ ONLY transaction). Output: <out_root>/<game>/ per game."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from .bridge import find_bun
from .paths import common_root

APP_ENV = "DUELWISE_APP_ROOT"
EXPORT_SCRIPT = Path("apps") / "web" / "scripts" / "export-human.ts"
PROFILE_SCRIPT = Path("apps") / "web" / "scripts" / "profile-holdem.ts"
CHESS_SHARDS_SCRIPT = Path("apps") / "web" / "scripts" / "human-chess-shards.ts"
EXPERT_FETCH = Path("scripts") / "data" / "fetch-lichess-expert.sh"
PUBLIC = Path("/Users/vidyutsriram/projects/duelwise-public")


class AppRootError(RuntimeError):
    pass


def app_root() -> Path:
    """The Duelwise app checkout that holds the TypeScript scripts: $DUELWISE_APP_ROOT, else the learn worktree of the public repo while
    it exists, else the public main checkout. (The private archive carries an older copy of the app without these scripts.)"""
    env = os.environ.get(APP_ENV)
    candidates = [Path(env)] if env else [PUBLIC / ".claude" / "worktrees" / "learn", PUBLIC]
    for c in candidates:
        if (c / EXPORT_SCRIPT).exists():
            return c
    raise AppRootError(f"no app checkout with {EXPORT_SCRIPT} (looked in {', '.join(map(str, candidates))}); set {APP_ENV}")


def human_root() -> Path:
    """Where exported human data lives: <common root>/data/human (gitignored: it holds players' match records)."""
    return common_root() / "data" / "human"


def _scrub(text: str) -> str:
    url = os.environ.get("DATABASE_URL")
    return text.replace(url, "[database url]") if url else text


def _run(cmd: list[str], cwd: Path, timeout: int) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items()}
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL)
    if p.returncode != 0:
        raise RuntimeError(f"{Path(cmd[1]).name} failed (exit {p.returncode}): {_scrub((p.stderr or p.stdout).strip())[-600:]}")
    return p


def require_database() -> None:
    if not os.environ.get("DATABASE_URL"):
        raise RuntimeError("DATABASE_URL is not set. Export it in the shell for this one command; nothing was read.")


def export_human(game: str, out_root: Path, *, extra: list[str] | None = None, timeout: int = 900) -> dict:
    """Exports `game` into <out_root>/<game>/ and returns its summary.json."""
    require_database()
    root = app_root()
    out_root.mkdir(parents=True, exist_ok=True)
    _run([find_bun(), str(root / EXPORT_SCRIPT), "--game", game, "--out", str(out_root), *(extra or [])], root, timeout)
    return json.loads((out_root / game / "summary.json").read_text())


def build_profiles(out_root: Path, timeout: int = 900) -> dict:
    require_database()
    root = app_root()
    out_root.mkdir(parents=True, exist_ok=True)
    p = _run([find_bun(), str(root / PROFILE_SCRIPT), "--out", str(out_root)], root, timeout)
    return json.loads(p.stdout.strip().splitlines()[-1])


def build_chess_shards(out_root: Path, timeout: int = 900) -> dict:
    """Human chess matches -> weighted policy shards in <out_root>/chess/shards."""
    root = app_root()
    p = _run([find_bun(), str(root / CHESS_SHARDS_SCRIPT), "--in", str(out_root), "--out", str(out_root / "chess" / "shards")], root, timeout)
    return json.loads(p.stdout.strip().splitlines()[-1])


def fetch_expert(cache_dir: Path, *, max_bytes: int, target: int, min_base: int = 180, sample: bool = False, resume: bool = True,
                 timeout: int = 4 * 3600) -> subprocess.CompletedProcess:
    """Downloads/filters Lichess expert games into <cache_dir>/b2200 (script in the app checkout). Always passes a byte cap."""
    root = app_root()
    cmd = ["bash", str(root / EXPERT_FETCH), "--out", str(cache_dir), "--max-bytes", str(max_bytes), "--target", str(target), "--min-base", str(min_base)]
    if sample:
        cmd.append("--sample")
    if resume:
        cmd.append("--resume")
    p = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    if p.returncode != 0:
        raise RuntimeError(f"fetch-lichess-expert failed (exit {p.returncode}): {(p.stderr or p.stdout).strip()[-600:]}")
    return p
