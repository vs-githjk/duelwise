"""One command per game for the learn-from-humans pipeline: export, train, gate, then print PASS or FAIL. It never publishes.

    bun run learn -- --game four|chess|holdem [--budget-minutes N] [--smoke]
    scripts/py -m trainer.cli learn --game chess

DATABASE_URL must be exported in the shell for the command (read only; it is never printed). The command does not write any registry,
copy any model into apps/web/public or flip `learns`: a PASS only means a candidate is ready for the existing publishers, which run
after Vidyut says go (locked rule, decisions.md 2026-10-30).

What each game does
  four    export (human + owner traffic, 20 matches per player per day, weights, 10 percent holdout) -> Four in a Row retrain adapter
          (self-play where up to 30 percent of games start from positions people reached) -> gates: challenger vs champion with at least
          400 games from EACH seat and a 95 percent Wilson lower bound above 0.5 from each seat; the existing pooled promotion gate
          (score 0.55, lower bound 0.5); a holdout play check from positions in the held-out human matches.
  chess   export -> human chess shards -> (if missing) Lichess 2200+ shards -> fine-tune b2200 from b1900 with human moves at most
          30 percent of each batch -> gates: held-out expert fit no worse than the starting net; the candidate as Hard against the live
          Hard and against Medium (400 games per seat, Wilson per seat) and against the 2-ply bot (the existing publish rule).
  holdem  export + opponent profiles only. No model is trained: the exploit adjustment is a design that is off by default, so there is
          nothing to gate and the result is FAIL ("no candidate"), with the profiles written for inspection.

Exit codes: 0 PASS, 1 FAIL, 2 could not run (no DATABASE_URL, no app checkout, bad arguments)."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from . import gates
from .bridge import find_bun
from .human_export import AppRootError, app_root, build_chess_shards, build_profiles, export_human, fetch_expert, human_root, use_pglite
from .ladder import GATE_MIN_GAMES, GATE_MIN_SCORE, promotion_gate
from .paths import runs_dir, worktree_root

GAMES = ("four", "chess", "holdem")
#: Gate games run in exactly two worker processes (the budget allows at most two; one process would wait on its own entry module).
PROCESSES = 2
CHESS_FINETUNE_LR = 5e-4
EXPERT_TARGET = 1_000_000
EXPERT_MAX_BYTES = 2_000_000_000


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def finish(game: str, work: Path, gate_rows: list[dict], extra: dict, log) -> dict:
    v = gates.verdict(gate_rows)
    result = {"game": game, "passed": v["passed"], "failed": v["failed"], "reasons": v["reasons"], "gates": gate_rows, "published": False,
              "finishedAt": datetime.now(timezone.utc).isoformat(), **extra}
    work.mkdir(parents=True, exist_ok=True)
    (work / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    log(gates.render(game, gate_rows))
    log(f"Nothing was published and no registry was touched. Result: {work / 'result.json'}")
    return result


def no_result(game: str, work: Path, reason: str, extra: dict, log) -> dict:
    """A run that cannot be gated is a FAIL with its reason, never a pass."""
    gate_rows = [{"gate": "candidate", "passed": False, "reasons": [reason]}]
    return finish(game, work, gate_rows, extra, log)


# --- Four in a Row ------------------------------------------------------------------------------------------------------------

def learn_four(work: Path, a: argparse.Namespace, log=print) -> dict:
    from .four.retrain_adapter import FourRetrainAdapter
    from .registry import load_registry

    root = worktree_root()
    reg = load_registry(root / "packages" / "agents" / "registry" / "four.json")
    adapter = FourRetrainAdapter(root=root, gate_root=app_root())
    data = work / "data"
    log(f"learn four: exporting (read only) into {data}")
    summary = adapter.export_matches(data)
    log(f"learn four: kept {summary.get('kept', 0)} of {summary.get('total', 0)} matches, rejected {summary.get('rejected', {})}")
    ch = adapter.train_challenger(work_dir=work / "challenger", budget_minutes=a.budget_minutes, data_dir=data, smoke=a.smoke, reg=reg, log=log)
    extra = {"export": summary, "training": ch.notes, "humanMatchesUsed": ch.human_matches_used, "smoke": a.smoke}
    if a.smoke:
        return no_result("four", work, "smoke run: the gate games are not played", extra, log)

    games = 2 * a.gate_games_per_seat
    log(f"learn four: gate, {games} games ({a.gate_games_per_seat} per seat) against the champion {reg['champion']}")
    g = adapter.run_gate(challenger=ch, reg=reg, games=games, sims=a.gate_sims, processes=PROCESSES)
    rows = [gates.seat_gate(g["bySeat"], per_seat=a.gate_games_per_seat, name="challenger vs champion, per seat"),
            {"gate": "challenger vs champion, pooled", **promotion_gate(g["points"], g["n"], GATE_MIN_GAMES, GATE_MIN_SCORE)}]
    hold = data / "holdout-starts.json"
    positions = len(json.loads(hold.read_text())["positions"]) if hold.exists() else 0
    if ch.human_matches_used > 0 and positions > 0:
        h = adapter.run_gate(challenger=ch, reg=reg, games=min(200, 2 * positions), sims=a.gate_sims, processes=PROCESSES, starts=hold, seed_base=7_500_000)
        rows.append(gates.play_holdout(h["points"], h["n"], ch.human_matches_used, positions))
    else:
        rows.append(gates.play_holdout(0.0, 0, ch.human_matches_used, positions))
    extra["gateGames"] = {"n": g["n"], "points": g["points"], "sims": g["sims"], "opponent": g["opponent"]}
    return finish("four", work, rows, extra, log)


# --- chess -------------------------------------------------------------------------------------------------------------------

def run_candidate_gate(onnx: Path, vs: str, a: argparse.Namespace) -> dict:
    script = app_root() / "packages" / "agents" / "src" / "measure" / "chess-candidate.ts"
    cmd = [find_bun(), str(script), "--candidate", str(onnx), "--vs", vs, "--games-per-seat", str(a.gate_games_per_seat), "--processes", "2"]
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=app_root(), timeout=8 * 3600, stdin=subprocess.DEVNULL)
    if p.returncode != 0:
        raise RuntimeError(f"chess candidate gate vs {vs} failed: {p.stderr.strip()[-500:]}")
    return json.loads(p.stdout.strip().splitlines()[-1])


def learn_chess(work: Path, a: argparse.Namespace, log=print) -> dict:
    from .chess.data import chess_cache_dir
    from .chess.train_policy import main as train_policy

    cache = chess_cache_dir()
    out_root = human_root()  # data/human/chess/ in the common root (gitignored)
    extra: dict = {"smoke": a.smoke}
    log(f"learn chess: exporting human games (read only) into {out_root / 'chess'}")
    summary = export_human("chess", out_root)
    log(f"learn chess: kept {summary['kept']} of {summary['total']} matches, rejected {summary['rejected']}")
    shards = build_chess_shards(out_root)
    extra.update(export=summary, humanShards=shards)
    human_dir = out_root / "chess" / "shards" if shards["records"] > 0 else None

    if not (cache / "b2200" / "index.json").exists():
        if a.skip_fetch:
            return no_result("chess", work, f"no b2200 Lichess shards in {cache} and --skip-fetch was given", extra, log)
        log(f"learn chess: fetching Lichess 2200+ games into {cache}/b2200 (cap {EXPERT_MAX_BYTES} bytes, target {EXPERT_TARGET} positions)")
        fetch_expert(cache, max_bytes=EXPERT_MAX_BYTES, target=EXPERT_TARGET)

    init = runs_dir() / "chess-policy" / "ckpt" / "b1900"
    run_dir = work / "run"
    argv = ["--buckets", "b2200", "--init-from", str(init), "--lr", str(CHESS_FINETUNE_LR), "--max-minutes", str(a.budget_minutes),
            "--run-dir", str(run_dir), "--ckpt-dir", str(work / "ckpt"), "--data-dir", str(cache), "--threads", "1"]
    if human_dir:
        argv += ["--human-dir", str(human_dir), "--human-share", "0.3"]
    if a.smoke:
        argv += ["--max-steps", "20", "--batch", "64", "--device", "cpu", "--eval-batches", "3"]
    log("learn chess: fine-tuning b2200 from b1900")
    if train_policy(argv) != 0:
        return no_result("chess", work, "the fine-tune stopped with an error", extra, log)
    onnx = run_dir / "export" / "b2200" / "policy.onnx"
    holdout = run_dir / "export" / "b2200" / "holdout.json"
    if not onnx.exists() or not holdout.exists():
        return no_result("chess", work, "the fine-tune did not finish (no exported net)", extra, log)
    h = json.loads(holdout.read_text())
    extra.update(humanMatchesUsed=shards["matches"] if h["humanRecords"] else 0, candidate=str(onnx), sha256=h["sha256"], steps=h["steps"])
    rows = [gates.fit_holdout(h["candidate"], h["baseline"])]
    if a.smoke:
        rows.append({"gate": "strength", "passed": False, "reasons": ["smoke run: the gate games are not played"]})
        return finish("chess", work, rows, extra, log)
    for vs in ("hard", "medium"):
        log(f"learn chess: gate vs {vs}, {a.gate_games_per_seat} games per seat")
        g = run_candidate_gate(onnx, vs, a)
        rows.append(gates.seat_gate([{"seat": r["seat"], "n": r["n"], "points": r["points"]} for r in g["bySeat"]], per_seat=a.gate_games_per_seat,
                                    name=f"Hard candidate vs {vs}, per seat"))
    log("learn chess: gate vs the 2-ply bot")
    g = run_candidate_gate(onnx, "twoply", a)
    rows.append(gates.pooled_gate(g["points"], g["n"], 0.7, 0.6, [{"seat": r["seat"], "n": r["n"], "points": r["points"]} for r in g["bySeat"]], "Hard candidate vs the 2-ply bot"))
    return finish("chess", work, rows, extra, log)


# --- Hold'em -----------------------------------------------------------------------------------------------------------------

def learn_holdem(work: Path, a: argparse.Namespace, log=print) -> dict:
    log("learn holdem: building opponent profiles (read only)")
    prof = build_profiles(work / "profiles")
    log(f"learn holdem: {prof['players']} players, {prof['confidentPlayers']} with 200+ hands, {prof['hands']} hands, "
        f"{prof['optedOutMatches']} matches left out by opt-out")
    reason = ("Hold'em learns profiles only. The exploit adjustment is a design that is off by default and has no trained model, so there is "
              "nothing to gate. Profiles are in " + str(work / "profiles" / "holdem-profiles"))
    return no_result("holdem", work, reason, {"profiles": prof, "smoke": a.smoke}, log)


RUNNERS = {"four": learn_four, "chess": learn_chess, "holdem": learn_holdem}


def add_arguments(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--game", required=True, choices=GAMES)
    ap.add_argument("--budget-minutes", type=float, default=25.0, help="training time (Four: self-play; chess: the b2200 fine-tune)")
    ap.add_argument("--smoke", action="store_true", help="a few seconds of plumbing; the gates are not played and the result is always FAIL")
    ap.add_argument("--gate-games-per-seat", type=int, default=gates.GATE_GAMES_PER_SEAT, help="never below 400 for a real run")
    ap.add_argument("--gate-sims", type=int, default=200, help="Four: simulations per move in the gate games")
    ap.add_argument("--skip-fetch", action="store_true", help="chess: do not download Lichess data when the b2200 shards are missing")
    ap.add_argument("--work-dir", default=None, help="default: runs/learn/<game>/<timestamp>")
    ap.add_argument("--pglite", default=None, help="rehearsal only: an absolute scratch PGlite folder to read (a copy is opened) instead of DATABASE_URL; the dev database is refused")


def run_cli(a: argparse.Namespace) -> int:
    if not a.smoke and a.gate_games_per_seat < gates.GATE_GAMES_PER_SEAT:
        print(f"learn: --gate-games-per-seat {a.gate_games_per_seat} is below the {gates.GATE_GAMES_PER_SEAT} a gate needs; use --smoke for a quick check", file=sys.stderr)
        return 2
    try:
        use_pglite(a.pglite)
    except RuntimeError as e:
        print(f"learn: {e}", file=sys.stderr)
        return 2
    if a.pglite is None and not os.environ.get("DATABASE_URL"):
        print("learn: DATABASE_URL is not set. Export it in this shell for this one command (read only); nothing was read, trained or gated.", file=sys.stderr)
        return 2
    work = Path(a.work_dir) if a.work_dir else runs_dir() / "learn" / a.game / stamp()
    t0 = time.monotonic()
    try:
        result = RUNNERS[a.game](work, a)
    except (AppRootError, RuntimeError, FileNotFoundError) as e:
        print(f"learn: could not run: {e}", file=sys.stderr)
        return 2
    print(f"learn {a.game}: finished in {(time.monotonic() - t0) / 60:.1f} minutes")
    return 0 if result["passed"] else 1
