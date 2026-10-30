"""The learning loop: export filtered human matches, train a challenger, gate it against the champion, record the run.

    bun run retrain -- --game four --budget-minutes 20 [--smoke]

A challenger ships only if it beats the current champion: at least 400 games, a score of at least 0.55 and a 95% Wilson
lower bound above 0.5. Every run is recorded as a `training_run` row (training/runs/retrain/<game>/training_runs.jsonl, the
table's columns; the app database is never written from here) and, unless --smoke, as a version in the game's registry:
a promoted champion, or a numbered candidate that shows why it did not ship. --smoke trains a handful of games to check the
plumbing; it never plays the gate, never promotes and never touches the registry."""

from __future__ import annotations

import argparse
import importlib
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from .ladder import GATE_MIN_GAMES, elo_gap, promotion_gate
from .paths import runs_dir, worktree_root
from .registry import add_version, atomic_write_text, load_registry, next_version, promote, write_registry
from .retrain_types import Challenger


class NoAdapter(Exception):
    """The game has no retrain adapter yet."""


def adapters_path(root: Path) -> Path:
    return root / "packages" / "agents" / "registry" / "adapters.json"


def load_adapters(root: Path) -> dict:
    p = adapters_path(root)
    return json.loads(p.read_text()) if p.exists() else {}


def resolve_adapter(root: Path, game: str):
    entry = load_adapters(root).get(game)
    if not isinstance(entry, dict) or not entry.get("adapter"):
        have = sorted(g for g, e in load_adapters(root).items() if isinstance(e, dict) and e.get("adapter"))
        raise NoAdapter(f"retrain: {game} has no retrain adapter yet (games with one: {', '.join(have) or 'none'}). Nothing was trained.")
    mod = importlib.import_module(entry["adapter"])
    return getattr(mod, entry.get("class", "RetrainAdapter"))(root=root)


def git_commit(root: Path) -> str:
    p = subprocess.run(["git", "-C", str(root), "rev-parse", "--short", "HEAD"], capture_output=True, text=True)
    return p.stdout.strip() or "unknown"


def now_iso() -> str:
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def append_training_run(runs: Path, game: str, row: dict) -> Path:
    path = runs / "retrain" / game / "training_runs.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(row) + "\n")
    return path


def set_learns(root: Path, game: str, learns: bool) -> None:
    adapters = load_adapters(root)
    entry = adapters.get(game)
    if isinstance(entry, dict) and entry.get("learns") != learns:
        entry["learns"] = learns
        atomic_write_text(adapters_path(root), json.dumps(adapters, indent=2) + "\n")


def retrain(game: str, budget_minutes: float, *, smoke: bool = False, root: Path | None = None, runs: Path | None = None,
            adapter=None, gate_games: int = GATE_MIN_GAMES, gate_sims: int = 200, processes: int = 2, log=print) -> dict:
    """Runs one learning-loop round and returns the training_run row (with `version` and `registryChanged`)."""
    root = root or worktree_root()
    runs = runs or runs_dir()
    adapter = adapter or resolve_adapter(root, game)  # raises NoAdapter before anything is trained
    reg_path = root / "packages" / "agents" / "registry" / f"{game}.json"
    reg = load_registry(reg_path)
    champion = reg["champion"]
    version = next_version(reg)
    work = runs / "retrain" / game / version
    created = now_iso()

    log(f"retrain {game}: challenger {version} against champion {champion}, {budget_minutes} min{' (smoke)' if smoke else ''}")
    summary = adapter.export_matches(work / "data")
    log(f"retrain {game}: export kept {summary.get('kept', 0)} of {summary.get('total', 0)} stored matches, rejected {summary.get('rejected', {})}")
    ch: Challenger = adapter.train_challenger(work_dir=work, budget_minutes=budget_minutes, data_dir=work / "data", smoke=smoke, reg=reg, log=log)

    row = {"id": f"{game}-{version}-{created}", "game": game, "challenger": version, "champion": champion, "gate": None,
           "promoted": False, "humanMatchesUsed": ch.human_matches_used, "createdAt": created, "smoke": smoke,
           "budgetMinutes": budget_minutes, "export": summary, "training": ch.notes, "version": version, "registryChanged": False}

    if smoke:
        row["gate"] = {"skipped": "smoke run: the gate is never played and nothing is promoted"}
        append_training_run(runs, game, row)
        return row

    points, n, info = adapter.play_gate(challenger=ch, reg=reg, games=gate_games, sims=gate_sims, processes=processes)
    gate = {**promotion_gate(points, n), **info}
    row["gate"] = gate

    rel = lambda p: str(p) if not Path(p).is_relative_to(root) else str(Path(p).relative_to(root))  # noqa: E731
    pub_dir = root / "apps" / "web" / "public" / "agents" / game / version
    if gate["passed"]:
        artifacts = {}
        for level, src in ch.artifacts.items():
            pub_dir.mkdir(parents=True, exist_ok=True)
            dst = pub_dir / Path(src).name
            shutil.copyfile(src, dst)
            artifacts[level] = rel(dst)
    else:
        artifacts = {level: str(Path(p).resolve().relative_to(runs.parent)) if Path(p).resolve().is_relative_to(runs.parent) else str(p)
                     for level, p in ch.artifacts.items()}
    new = add_version(reg, version=version, parent=champion, artifacts=artifacts, sha256=ch.sha256, trained_steps=ch.trained_steps,
                      human_matches_used=ch.human_matches_used, gate=gate, created_at=created)
    if gate["passed"]:
        prev = reg["measured"].get("champion", {})
        score = gate["score"]
        block = {"metric": f"score vs {champion} champion", "value": score, "ci95": gate["ci95"], "n": n, "opponents": f"{champion} champion",
                 "siteElo": round(prev.get("siteElo", 1000.0) + elo_gap(score), 6), "measuredAt": created, "harness": info.get("harness", "bun"),
                 "commit": git_commit(root)}
        cfg = {**reg["levels"]["champion"]["config"], "snapshot": f"retrain-{version}", "retrainOf": champion, "selfPlayGames": ch.notes.get("selfPlayGames", 0)}
        new = promote(new, version=version, level_config=cfg, measured_block=block, promoted_at=created)
        row["promoted"] = True
        if ch.human_matches_used > 0:
            set_learns(root, game, True)
    write_registry(reg_path, new)
    row["registryChanged"] = True
    append_training_run(runs, game, row)
    return row


def add_arguments(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--game", required=True)
    ap.add_argument("--budget-minutes", type=float, default=20.0, help="self-play and training time for the challenger")
    ap.add_argument("--smoke", action="store_true", help="a few games to check the plumbing; never plays the gate, never promotes")
    ap.add_argument("--gate-games", type=int, default=GATE_MIN_GAMES)
    ap.add_argument("--gate-sims", type=int, default=200, help="simulations per move for both nets in the gate games")
    ap.add_argument("--processes", type=int, default=2)


def run_cli(a: argparse.Namespace) -> int:
    try:
        row = retrain(a.game, a.budget_minutes, smoke=a.smoke, gate_games=a.gate_games, gate_sims=a.gate_sims, processes=a.processes)
    except NoAdapter as e:
        print(str(e), file=sys.stderr)
        return 2
    g = row["gate"] or {}
    verdict = "SMOKE (not gated, not promoted)" if row["smoke"] else ("PROMOTED" if row["promoted"] else "NOT PROMOTED")
    print(f"retrain {row['game']}: {row['challenger']} {verdict}; gate {json.dumps({k: g[k] for k in ('n', 'score', 'ci95', 'passed', 'reasons') if k in g})}; "
          f"human matches used {row['humanMatchesUsed']}")
    return 0
