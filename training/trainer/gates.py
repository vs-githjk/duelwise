"""Strength and holdout gates for the learn-from-humans command. A learned model passes only if EVERY gate here passes.

Seat gate: at least 400 games from each seat, and the 95 percent Wilson lower bound of the candidate's score above 0.5 from each seat
(the rule the chess and Four publishers already apply). Holdout gate: the candidate must not be worse than what it replaces on data it
never trained on. Nothing in here writes a registry or publishes anything."""

from __future__ import annotations

from .ladder import wilson

GATE_GAMES_PER_SEAT = 400
SEAT_FLOOR = 0.5
#: Fit holdout (chess): the candidate may not fit held-out expert moves worse than the net it started from, by more than this.
FIT_TOLERANCE = 0.0
#: Play holdout (Four): from positions people reached, the candidate must score at least this against the champion.
HOLDOUT_PLAY_FLOOR = 0.5
HOLDOUT_MIN_GAMES = 100


def seat_gate(by_seat: list[dict], per_seat: int = GATE_GAMES_PER_SEAT, floor: float = SEAT_FLOOR, name: str = "seat gate") -> dict:
    """by_seat rows: {seat, n, points}. Passes when both seats are present, have `per_seat` games and a Wilson lower bound above `floor`."""
    reasons: list[str] = []
    rows = []
    seats = {r["seat"] for r in by_seat}
    if seats != {0, 1}:
        reasons.append(f"both seats are needed, got {sorted(seats)}")
    for r in sorted(by_seat, key=lambda r: r["seat"]):
        n, pts = int(r["n"]), float(r["points"])
        lo, hi = wilson(pts, n)
        rows.append({"seat": r["seat"], "n": n, "points": pts, "score": round(pts / n, 4) if n else 0.0, "ci95": [round(lo, 4), round(hi, 4)]})
        if n < per_seat:
            reasons.append(f"seat {r['seat']}: only {n} games, {per_seat} needed")
        if not lo > floor:
            reasons.append(f"seat {r['seat']}: 95% lower bound {lo:.4f} is not above {floor}")
    return {"gate": name, "rule": f"{per_seat} games per seat, each seat's 95% Wilson lower bound above {floor}", "bySeat": rows,
            "passed": not reasons, "reasons": reasons}


def pooled_gate(points: float, n: int, floor: float, per_seat_floor: float, by_seat: list[dict], name: str) -> dict:
    """A pooled score floor plus a floor for each seat (the existing 2-ply bot rule for chess Hard)."""
    reasons: list[str] = []
    if n and points / n < floor:
        reasons.append(f"pooled score {points / n:.4f} is below {floor}")
    for r in by_seat:
        if r["n"] < 200:
            reasons.append(f"seat {r['seat']}: only {r['n']} games, 200 needed")
        elif r["points"] / r["n"] < per_seat_floor:
            reasons.append(f"seat {r['seat']}: score {r['points'] / r['n']:.4f} is below {per_seat_floor}")
    return {"gate": name, "n": n, "score": round(points / n, 4) if n else 0.0, "bySeat": by_seat, "passed": not reasons and n > 0, "reasons": reasons}


def fit_holdout(candidate: dict, baseline: dict, tolerance: float = FIT_TOLERANCE) -> dict:
    """Held-out expert moves: the candidate's top-1 accuracy must not fall below the starting net's, and its loss must not rise."""
    reasons = []
    if candidate["val_top1"] + tolerance < baseline["val_top1"]:
        reasons.append(f"top-1 {candidate['val_top1']:.4f} is below the starting net's {baseline['val_top1']:.4f}")
    if candidate["val_loss"] > baseline["val_loss"] + tolerance:
        reasons.append(f"loss {candidate['val_loss']:.4f} is above the starting net's {baseline['val_loss']:.4f}")
    return {"gate": "holdout fit", "candidate": candidate, "baseline": baseline, "passed": not reasons, "reasons": reasons}


def play_holdout(points: float, n: int, human_matches_used: int, holdout_positions: int, floor: float = HOLDOUT_PLAY_FLOOR,
                 min_games: int = HOLDOUT_MIN_GAMES) -> dict:
    """From positions people reached in the held-out matches, the candidate must not score below `floor` against the champion.

    A candidate that used no human matches cannot have been moved by human data, so the check does not apply. A candidate that did use
    human matches with no usable holdout cannot be checked, and that is a FAIL, not a pass."""
    if human_matches_used == 0:
        return {"gate": "holdout play", "passed": True, "applies": False, "reasons": [], "note": "no human matches were used, nothing for a holdout to catch"}
    if n < min_games or holdout_positions == 0:
        return {"gate": "holdout play", "passed": False, "applies": True, "n": n, "holdoutPositions": holdout_positions,
                "reasons": [f"human matches were used but the holdout gave only {n} games from {holdout_positions} positions ({min_games} games needed)"]}
    score = points / n
    reasons = [] if score >= floor else [f"score {score:.4f} from held-out human positions is below {floor}"]
    return {"gate": "holdout play", "passed": not reasons, "applies": True, "n": n, "points": points, "score": round(score, 4),
            "holdoutPositions": holdout_positions, "reasons": reasons}


def verdict(gates: list[dict]) -> dict:
    failed = [g for g in gates if not g["passed"]]
    return {"passed": bool(gates) and not failed, "failed": [g["gate"] for g in failed], "reasons": [f"{g['gate']}: {r}" for g in failed for r in g["reasons"]]}


def render(game: str, gates: list[dict]) -> str:
    v = verdict(gates)
    lines = [f"learn {game}:"]
    for g in gates:
        lines.append(f"  {'PASS' if g['passed'] else 'FAIL'}  {g['gate']}" + ("" if g["passed"] else "  (" + "; ".join(g["reasons"]) + ")"))
    lines.append(f"RESULT: {'PASS' if v['passed'] else 'FAIL'}")
    return "\n".join(lines)
