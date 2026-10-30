"""Pick the Four in a Row level checkpoints from the four-az snapshots (T23).

Easy   = the earliest snapshot whose raw policy, sampled at EASY_TEMPERATURE over the legal columns (the shipped Easy
         config: no search, packages/agents/src/four/agent.ts), beats uniformly random play in at least 90% of seeded games.
Medium = the snapshot nearest the midpoint of the snapshot list between Easy and the latest.
Hard, Champion = the latest snapshot.

The chosen ONNX files are copied to apps/web/public/agents/four/v1/<level>.onnx, the table of every snapshot goes to
packages/agents/eval/four-snapshots.json, and a parity fixture (positions as column sequences, the torch net's
logits and values) goes to packages/agents/eval/four-parity.json so the TS evaluator is checked against the Python net.

    scripts/py -m trainer.four.pick_levels --snapshots <dir> [--games 200] [--out-web <dir>] [--out-eval <dir>]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

from .board import COLS, PLANES, ROWS
from .net import AZNet

BEAT_RANDOM = 0.90
# Must equal the Easy temperature in packages/agents/src/four/agent.ts (a test pins both).
EASY_TEMPERATURE = 0.15
LEVEL_ORDER = ("easy", "medium", "hard", "champion")


class Position:
    """Minimal rules: stones per seat as a (6, 7) grid, row 0 at the bottom."""

    def __init__(self) -> None:
        self.board = np.zeros((ROWS, COLS), dtype=np.int8)  # 0 empty, 1 seat 0, 2 seat 1
        self.heights = [0] * COLS
        self.n = 0
        self.winner: int | None = None

    def legal(self) -> list[int]:
        return [c for c in range(COLS) if self.heights[c] < ROWS]

    def play(self, col: int) -> None:
        seat = self.n % 2
        r = self.heights[col]
        self.board[r, col] = 1 + seat
        self.heights[col] += 1
        self.n += 1
        if self._wins(r, col, 1 + seat):
            self.winner = seat

    def _wins(self, r: int, c: int, who: int) -> bool:
        for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
            k = 1
            for sign in (1, -1):
                rr, cc = r + sign * dr, c + sign * dc
                while 0 <= rr < ROWS and 0 <= cc < COLS and self.board[rr, cc] == who:
                    k += 1
                    rr += sign * dr
                    cc += sign * dc
            if k >= 4:
                return True
        return False

    @property
    def over(self) -> bool:
        return self.winner is not None or self.n >= ROWS * COLS

    def features(self) -> np.ndarray:
        seat = self.n % 2
        mine, theirs = 1 + seat, 2 - seat
        x = np.ones((PLANES, ROWS, COLS), dtype=np.float32)
        x[0] = self.board == mine
        x[1] = self.board == theirs
        return x


def snapshot_files(snap_dir: Path) -> list[Path]:
    files = sorted(snap_dir.glob("snap-*.onnx"), key=lambda p: int(p.stem.split("-")[1]))
    if not files:
        raise SystemExit(f"no snapshots in {snap_dir}")
    return files


def sample_policy(logits: np.ndarray, legal: list[int], rng: np.random.Generator, temperature: float = EASY_TEMPERATURE) -> int:
    z = logits[legal].astype(np.float64) / temperature
    p = np.exp(z - z.max())
    p /= p.sum()
    return int(legal[int(rng.choice(len(legal), p=p))])


def beat_random_rate(sess: ort.InferenceSession, games: int, seed: int) -> float:
    """Share of games won (a draw counts half) by the sampled raw policy against uniformly random play, seats alternating."""
    rng = np.random.default_rng(seed)
    points = 0.0
    for g in range(games):
        net_seat = g % 2
        pos = Position()
        while not pos.over:
            legal = pos.legal()
            if pos.n % 2 == net_seat:
                logits = sess.run(None, {"input": pos.features()[None]})[0][0]
                pos.play(sample_policy(logits, legal, rng))
            else:
                pos.play(int(legal[int(rng.integers(len(legal)))]))
        points += 0.5 if pos.winner is None else (1.0 if pos.winner == net_seat else 0.0)
    return points / games


def pick(rates: list[float]) -> dict[str, int]:
    """Indices into the snapshot list for each level."""
    last = len(rates) - 1
    easy = next((i for i, r in enumerate(rates) if r >= BEAT_RANDOM), last)
    medium = easy + (last - easy) // 2
    return {"easy": easy, "medium": medium, "hard": last, "champion": last}


def parity_fixture(pt_path: Path, count: int, seed: int) -> list[dict]:
    blob = torch.load(pt_path, map_location="cpu")
    blocks, channels = blob["arch"]
    model = AZNet(blocks, channels)
    model.load_state_dict(blob["model"])
    model.eval()
    rng = np.random.default_rng(seed)
    out = []
    while len(out) < count:
        pos = Position()
        target = int(rng.integers(0, 30))
        moves: list[int] = []
        while not pos.over and len(moves) < target:
            c = int(pos.legal()[int(rng.integers(len(pos.legal())))])
            pos.play(c)
            moves.append(c)
        if pos.over:
            continue
        with torch.no_grad():
            logits, value = model(torch.from_numpy(pos.features()[None]))
        out.append({"moves": moves, "logits": [float(v) for v in logits[0]], "value": float(value[0])})
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshots", required=True)
    ap.add_argument("--games", type=int, default=200)
    ap.add_argument("--seed", type=int, default=23)
    ap.add_argument("--out-web", required=True, help="apps/web/public/agents/four/v1")
    ap.add_argument("--out-eval", required=True, help="packages/agents/eval")
    ap.add_argument("--parity-positions", type=int, default=12)
    args = ap.parse_args(argv)

    files = snapshot_files(Path(args.snapshots))
    rates = []
    for f in files:
        sess = ort.InferenceSession(str(f), providers=["CPUExecutionProvider"])
        rate = beat_random_rate(sess, args.games, args.seed)
        rates.append(rate)
        print(f"{f.stem}: raw policy (temperature {EASY_TEMPERATURE}) scores {rate:.3f} against random over {args.games} games", flush=True)

    picks = pick(rates)
    web, ev = Path(args.out_web), Path(args.out_eval)
    web.mkdir(parents=True, exist_ok=True)
    ev.mkdir(parents=True, exist_ok=True)
    chosen = {}
    for level in LEVEL_ORDER:
        src = files[picks[level]]
        dst = web / f"{level}.onnx"
        shutil.copyfile(src, dst)
        chosen[level] = {
            "snapshot": src.stem,
            "games": int(src.stem.split("-")[1]),
            "steps": int(torch.load(src.with_suffix(".pt"), map_location="cpu")["steps"]),
            "file": f"{level}.onnx",
            "sha256": hashlib.sha256(dst.read_bytes()).hexdigest(),
        }
    table = {
        "rule": f"Easy: earliest snapshot whose raw policy sampled at temperature {EASY_TEMPERATURE} scores at least 0.90 against random; Medium: midpoint snapshot; Hard and Champion: latest",
        "beatRandomThreshold": BEAT_RANDOM,
        "gamesPerSnapshot": args.games,
        "seed": args.seed,
        "snapshots": [{"snapshot": f.stem, "games": int(f.stem.split("-")[1]), "scoreVsRandom": round(r, 4)} for f, r in zip(files, rates)],
        "levels": chosen,
    }
    (ev / "four-snapshots.json").write_text(json.dumps(table, indent=1) + "\n")
    latest_pt = files[picks["champion"]].with_suffix(".pt")
    parity = {
        "snapshot": latest_pt.stem,
        "model": "champion.onnx",
        "tolerance": 1e-5,
        "positions": parity_fixture(latest_pt, args.parity_positions, args.seed),
    }
    (ev / "four-parity.json").write_text(json.dumps(parity, indent=1) + "\n")
    print(json.dumps({k: v["snapshot"] for k, v in chosen.items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
