"""Lichess puzzle sample for the chess puzzle-accuracy measurement (T27).

The Lichess puzzle database is CC0 (https://database.lichess.org/#puzzles). The full CSV is streamed through
`zstd -dc` and reduced, in one pass, to a seeded sample per rating band, written as JSON for the TypeScript
harness (packages/agents/src/measure/chess.ts):

    scripts/py -m trainer.chess.puzzles [--csv <lichess_db_puzzle.csv.zst>] [--out <puzzles.json>] [--per-band 300] [--seed 0]

Puzzle format (Lichess): `FEN` is the position BEFORE the opponent's first move; `Moves` is the UCI line, the first move
being the opponent's, then the solver's move, the reply, and so on. Only puzzles with a reliable rating (rating deviation
at most 100) and at least 100 plays are sampled, so a band's label means what it says.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import subprocess
from pathlib import Path
from typing import Iterable, Iterator

from ..paths import atomic_write_bytes, common_root

# Half-open rating bands [lo, hi). The last one is open at the top.
BANDS: list[tuple[int, int]] = [(400, 900), (900, 1300), (1300, 1700), (1700, 2100), (2100, 2500), (2500, 4000)]
MAX_RD = 100
MIN_PLAYS = 100


def band_of(rating: int, bands: list[tuple[int, int]] = BANDS) -> int | None:
    for i, (lo, hi) in enumerate(bands):
        if lo <= rating < hi:
            return i
    return None


def usable(row: dict) -> bool:
    try:
        return int(row["RatingDeviation"]) <= MAX_RD and int(row["NbPlays"]) >= MIN_PLAYS and len(row["Moves"].split()) >= 2
    except (KeyError, ValueError):
        return False


def sample_puzzles(rows: Iterable[dict], per_band: int, seed: int, bands: list[tuple[int, int]] = BANDS) -> list[dict]:
    """Reservoir sample of `per_band` usable puzzles in each band, one pass, deterministic for a given row order and seed."""
    rng = random.Random(seed)
    reservoirs: list[list[dict]] = [[] for _ in bands]
    seen = [0] * len(bands)
    for row in rows:
        if not usable(row):
            continue
        b = band_of(int(row["Rating"]), bands)
        if b is None:
            continue
        item = {"id": row["PuzzleId"], "fen": row["FEN"], "moves": row["Moves"].split(), "rating": int(row["Rating"]), "themes": row["Themes"].split()}
        seen[b] += 1
        if len(reservoirs[b]) < per_band:
            reservoirs[b].append(item)
        else:
            j = rng.randrange(seen[b])
            if j < per_band:
                reservoirs[b][j] = item
    out: list[dict] = []
    for b, res in enumerate(reservoirs):
        res.sort(key=lambda p: p["id"])
        for p in res:
            p["band"] = b
            out.append(p)
    return out


def read_rows(csv_zst: Path) -> Iterator[dict]:
    proc = subprocess.Popen(["zstd", "-dc", str(csv_zst)], stdout=subprocess.PIPE, text=True, bufsize=1 << 20)
    assert proc.stdout is not None
    try:
        yield from csv.DictReader(proc.stdout)
    finally:
        proc.stdout.close()
        proc.wait()


def main(argv: list[str] | None = None) -> int:
    root = common_root()
    ap = argparse.ArgumentParser(description="sample Lichess puzzles per rating band")
    ap.add_argument("--csv", default=str(root / "data/raw/lichess_db_puzzle.csv.zst"))
    ap.add_argument("--out", default=str(root / "data/cache/chess/puzzles.json"))
    ap.add_argument("--per-band", type=int, default=300)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args(argv)
    sample = sample_puzzles(read_rows(Path(a.csv)), a.per_band, a.seed)
    doc = {"source": "https://database.lichess.org/lichess_db_puzzle.csv.zst (CC0)", "bands": BANDS, "perBand": a.per_band, "seed": a.seed, "puzzles": sample}
    atomic_write_bytes(a.out, json.dumps(doc, separators=(",", ":")).encode())
    counts = [sum(1 for p in sample if p["band"] == i) for i in range(len(BANDS))]
    print(f"wrote {len(sample)} puzzles to {a.out}; per band {counts}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
