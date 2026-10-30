"""The scripted-bot publish gate for the real-time games (R15).

A level publishes only if its learner, on both seats and under the level's own limits, beats the scripted bots
(which play under the same limits and the same delayed view) by the margins below. The bars are Wilson 95% LOWER
bounds over 400 matches per bot, which T25 (fighter) and T26 (arena) measure. During training this module runs a
cheap screen at every few snapshots: a smaller sample, passing when the point estimate clears the bar. A snapshot
that passes is copied to <run>/gated/<level>/ and listed in <run>/levels/gated.json for T25 and T26 to measure in full.
A snapshot that fails is logged and stays out of that list, so a league whose self-play rates look healthy can no
longer hide a collapse against simple opponents.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from ..paths import atomic_write_bytes
from . import league as L

# Role of each scripted bot: the aggressive one, the defensive one, the random one.
ROLE = {
    "fighter": {"rushdown": "rush", "turtle": "turtle", "random": "random", "zoner": "zoner", "throwloop": "throwloop", "backwalk": "backwalk", "pokeloop": "pokeloop", "sweepspam": "sweepspam", "fireball": "fireball", "throwtap": "throwtap", "fireball25": "fireball25"},
    "arena": {"rusher": "rush", "holder": "turtle", "random": "random", "peeker": "peek", "strafe": "strafe", "holdangle": "holdangle", "human-proxy": "human-proxy"},
}

# (rush, turtle, random, the fighter's six exploit bots (KC1 added pokeloop, sweepspam and fireball) and the arena's peeker, strafe and holdangle, all R30) Wilson 95% lower bounds, 400 matches per bot (R15). Champion plays bots that see the live game.
PUBLISH_BARS: dict[str, dict[str, float]] = {
    "hard": {"rush": 0.60, "turtle": 0.60, "random": 0.95, "zoner": 0.60, "throwloop": 0.60, "backwalk": 0.60, "pokeloop": 0.60, "sweepspam": 0.60, "fireball": 0.60, "throwtap": 0.60, "fireball25": 0.60, "peek": 0.60, "strafe": 0.60, "holdangle": 0.60},
    "medium": {"rush": 0.50, "turtle": 0.50, "random": 0.90, "peek": 0.50, "strafe": 0.50, "holdangle": 0.50},
    "easy": {"rush": 0.35, "turtle": 0.35, "random": 0.85, "peek": 0.35, "strafe": 0.35, "holdangle": 0.35},
    "champion": {"rush": 0.75, "turtle": 0.75, "zoner": 0.75, "throwloop": 0.75, "backwalk": 0.75, "pokeloop": 0.75, "sweepspam": 0.75, "fireball": 0.75, "throwtap": 0.75, "fireball25": 0.75, "peek": 0.75, "strafe": 0.75, "holdangle": 0.75},
}


def bar_for(game: str, level: str, bot: str) -> float | None:
    """The bar a level must clear against a bot, or None when the level has no bar against it."""
    return PUBLISH_BARS[level].get(ROLE[game][bot])


def gate_check(agent, game: str, level: str, *, games_per_bot: int = 48, n_envs: int = 16, seed: int = 70_000, rounds_per_bot: int = 96) -> dict:
    """Quick screen: the learner against every scripted bot, balanced over both seats and per env.

    Fighter: matches (best of 3), `games_per_bot` of them. Arena: whole matches are about 15 rounds, so the
    screen counts rounds (`rounds_per_bot`) and compares the round win rate to the bar. The point estimate must
    clear the bar; the 400-match Wilson measurement is T25 and T26's.
    """
    from .eval_bots import evaluate  # eval_bots imports train_realtime, which imports this module

    bots = {}
    ok = True
    for bot in L.BOTS[game]:
        bar = bar_for(game, level, bot)
        if bar is None:
            continue
        if game == "arena":
            r = evaluate(agent, bot, 0, game=game, level=level, n_envs=n_envs, seed=seed, rounds=rounds_per_bot)
            score = r["roundWinRate"]
        else:
            r = evaluate(agent, bot, games_per_bot, game=game, level=level, n_envs=n_envs, seed=seed)
            score = r["score"]
        passed = score >= bar
        ok = ok and passed
        bots[bot] = {"score": round(score, 4), "bar": bar, "games": r["games"], "passed": passed}
    return {"level": level, "passed": ok, "bots": bots}


def record_gate(run_dir: Path, game: str, level: str, step: int, result: dict, state: dict) -> None:
    """Appends the result to gates/<level>.jsonl; a pass also saves the weights and updates levels/gated.json."""
    run_dir = Path(run_dir)
    (run_dir / "gates").mkdir(parents=True, exist_ok=True)
    with open(run_dir / "gates" / f"{level}.jsonl", "a") as f:
        f.write(json.dumps({"t": round(time.time()), **result}) + "\n")
    if not result["passed"]:
        return
    path = L.save_snapshot(run_dir / "gated" / level, level, step, state)
    gated_file = run_dir / "levels" / "gated.json"
    try:
        data = json.loads(gated_file.read_text())
    except (OSError, ValueError):
        data = {"game": game, "levels": {}}
    data["levels"][level] = {"path": str(path), "step": step, "screen": result["bots"], "writtenAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    atomic_write_bytes(gated_file, (json.dumps(data, indent=2) + "\n").encode())
