"""Ladder statistics, the same arithmetic as packages/agents/src/measure/ladder.ts (a test pins Wilson to the TS value).

Used by the retrain promotion gate and by anything in Python that reads or checks a measured ladder."""

from __future__ import annotations

import math
from typing import Iterable, Sequence

Z95 = 1.959964
Z99 = 2.575829

LEVELS = ("easy", "medium", "hard", "champion")
SCORE_CLAMP = 0.01  # elo.ts clamps pair scores into [0.01, 0.99] before taking the Elo gap


def wilson(points: float, n: int, z: float = Z95) -> tuple[float, float]:
    """Wilson score interval for `points` successes (wins plus half draws) in `n` games."""
    if n <= 0:
        return (0.0, 1.0)
    p = points / n
    z2 = z * z
    denom = 1 + z2 / n
    centre = p + z2 / (2 * n)
    margin = z * math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
    return (max(0.0, (centre - margin) / denom), min(1.0, (centre + margin) / denom))


def interim_look(points: float, n: int, looks: Iterable[int]) -> bool:
    """A ladder may stop early only at a planned look count and only when the 99% lower bound is above 50%."""
    return n in set(looks) and wilson(points, n, Z99)[0] > 0.5


def elo_gap(score: float) -> float:
    s = min(1 - SCORE_CLAMP, max(SCORE_CLAMP, score))
    return 400 * math.log10(s / (1 - s))


def ladder_to_elo(pairs: Sequence[dict], anchor_level: str = "easy", anchor_elo: float = 1000.0) -> dict[str, float]:
    """Chained site Elo from adjacent pairs ({lower, upper, score} or {lower, upper, points, n}); the anchor level gets `anchor_elo`."""
    gaps: dict[int, float] = {}
    for p in pairs:
        lo = LEVELS.index(p["lower"])
        if LEVELS.index(p["upper"]) != lo + 1:
            raise ValueError(f"pairs must be adjacent levels, got {p['lower']} and {p['upper']}")
        gaps[lo] = elo_gap(p["score"] if "score" in p else p["points"] / p["n"])
    a = LEVELS.index(anchor_level)
    out = {anchor_level: anchor_elo}
    i = a
    while i < len(LEVELS) - 1 and i in gaps:
        out[LEVELS[i + 1]] = out[LEVELS[i]] + gaps[i]
        i += 1
    i = a - 1
    while i >= 0 and i in gaps:
        out[LEVELS[i]] = out[LEVELS[i + 1]] - gaps[i]
        i -= 1
    return out


def pair_stats(points: float, n: int) -> dict:
    lo, hi = wilson(points, n)
    return {"points": points, "n": n, "score": points / n if n else 0.0, "ci95": [lo, hi], "passed": lo > 0.5}


def check_monotone(pairs: Sequence[dict], levels: Sequence[str] = LEVELS) -> tuple[bool, list[str]]:
    """A ladder is publishable when every adjacent pair separated (95% lower bound above 50%) and site Elo rises level by level."""
    failures: list[str] = []
    stats = [{**p, **pair_stats(p["points"], p["n"])} if "ci95" not in p else p for p in pairs]
    for p in stats:
        if not p["ci95"][0] > 0.5:
            failures.append(
                f"{p['upper']} does not beat {p['lower']}: score {p['score']:.4f} over {p['n']} games, "
                f"95% interval [{p['ci95'][0]:.4f}, {p['ci95'][1]:.4f}]"
            )
    elo = ladder_to_elo(stats, levels[0], 1000.0)
    for lo, hi in zip(levels, levels[1:]):
        if lo not in elo or hi not in elo or not elo[hi] > elo[lo]:
            failures.append(f"{hi} site Elo is not above {lo}")
    return (not failures, failures)


# --- the retrain promotion gate -----------------------------------------------------------------------------------
GATE_MIN_GAMES = 400
GATE_MIN_SCORE = 0.55


def promotion_gate(points: float, n: int, min_games: int = GATE_MIN_GAMES, min_score: float = GATE_MIN_SCORE) -> dict:
    """A challenger ships only if it beats the champion: at least `min_games` games, a score of at least `min_score`,
    and a 95% Wilson lower bound above 50%. Returns the gate record that is stored with the version."""
    lo, hi = wilson(points, n)
    score = points / n if n else 0.0
    reasons = []
    if n < min_games:
        reasons.append(f"only {n} games, at least {min_games} needed")
    if score < min_score:
        reasons.append(f"score {score:.4f} is below {min_score}")
    if not lo > 0.5:
        reasons.append(f"95% lower bound {lo:.4f} is not above 0.5")
    return {
        "rule": f"challenger vs champion: at least {min_games} games, score at least {min_score}, 95% Wilson lower bound above 0.5",
        "n": n,
        "points": points,
        "score": round(score, 6),
        "ci95": [round(lo, 6), round(hi, 6)],
        "passed": not reasons,
        "reasons": reasons,
    }
