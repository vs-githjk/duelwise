"""Four in a Row's retrain adapter (T24): fine-tune the champion by self-play, where up to 30% of games start from
positions that people reached in filtered human matches.

A human-reached position is a start only: the games from it are played by search (PUCT), the policy target is the search
visit shares as always, and the value target is the game outcome corrected towards the search's own root value
(`q_mix`), so a start position a person got into by a mistake is not scored as if the agent had chosen it.

Interface (trainer.retrain calls these):
    export_matches(out_dir)  -> summary dict (apps/web/scripts/export-matches.ts)
    champion_source(reg)     -> Path of the champion's .pt (arch + weights)
    train_challenger(...)    -> Challenger
    play_gate(...)           -> (points, n, info)  challenger vs champion through the TS harness
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import numpy as np
import torch

from ..bridge import find_bun
from ..human_export import export_human, human_root
from ..paths import common_root, runs_dir, worktree_root
from ..registry import champion_artifact
from ..retrain_types import Challenger
from .board import COLS, replay_game
from .replay_buffer import ReplayBuffer
from .train import FourTrainer

START_SHARE = 0.3
Q_MIX = 0.5


class SoftReplayBuffer(ReplayBuffer):
    """Replay window whose value targets are floats, so search-corrected targets survive (the base buffer keeps int8 outcomes)."""

    def __init__(self, window_games: int = 50_000, q_mix: float = Q_MIX):
        super().__init__(window_games)
        self.q_mix = q_mix

    def _rows(self, g: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        prefix: list[int] = list(g.get("prefix") or [])
        k = len(prefix)
        visits = [[0] * COLS] * k + [list(v) for v in g["visits"]]
        planes, policy, z = replay_game(prefix + list(g["moves"]), visits, g["winner"])
        planes, policy, z = planes[k:], policy[k:], z[k:].astype(np.float32)
        if k and g.get("q"):
            z = (1 - self.q_mix) * z + self.q_mix * np.asarray(g["q"], dtype=np.float32)
        return planes, policy, z

    def add_games(self, games: list[dict]) -> int:
        parts = [self._rows(g) for g in games if not g.get("truncated") and g["moves"]]
        if not parts:
            return 0
        planes = np.concatenate([p[0] for p in parts])
        policy = np.concatenate([p[1] for p in parts]).astype(np.float16)
        z = np.concatenate([p[2] for p in parts]).astype(np.float16)
        self._chunks.append((len(parts), planes, policy, z))
        self._games += len(parts)
        while self._games > self.window_games and len(self._chunks) > 1:
            self._games -= self._chunks.popleft()[0]
        self._flat = None
        return len(z)


class RetrainTrainer(FourTrainer):
    def __init__(self, blocks: int, channels: int, lr: float, window_games: int, seed: int):
        super().__init__(blocks, channels, lr, window_games=window_games, seed=seed)
        self.buffer = SoftReplayBuffer(window_games)

    def load_weights(self, pt: Path) -> None:
        ck = torch.load(pt, map_location="cpu", weights_only=True)
        self.model.load_state_dict(ck["model"])
        self.steps = int(ck.get("steps", 0))

    def round(self, games: int, parallel: int, sims: int, train_ratio: float, batch: int, seed: int, workers: int,
              extra: list[str]) -> dict:
        finished = self.selfplay(games, parallel, sims, seed, extra=extra, workers=workers)
        added = self.buffer.add_games(finished)
        self.games_total += len(finished)
        steps = max(1, int(added * train_ratio / batch)) if added else 0
        pl = vl = float("nan")
        if steps:
            pl, vl = self.train_steps(steps, batch)
        self.iterations += 1
        return {"games": len(finished), "from_human_starts": sum(1 for g in finished if g.get("prefix")),
                "positions_added": added, "steps": steps, "policy_loss": pl, "value_loss": vl}


def positions_of(moves: list[int], min_ply: int = 4) -> int:
    """How many start positions one match gives (mirrors fourStartPositions in packages/core/src/filters/four.ts)."""
    return max(0, len(moves) - 1 - min_ply)


class FourRetrainAdapter:
    game = "four"

    def __init__(self, *, root: Path | None = None, gate_root: Path | None = None, champion_pt: Path | None = None, games_per_iter: int = 64,
                 parallel: int = 64, sims: int = 100, workers: int = 2, lr: float = 3e-4, window_games: int = 4000,
                 train_ratio: float = 4.0, batch: int = 128, seed: int = 0, smoke_games: int = 8, smoke_sims: int = 8):
        self.root = root or worktree_root()
        # The checkout whose four-gate.ts plays the gate games (per-seat results, holdout starts); the learn command points it at the app checkout.
        self.gate_root = gate_root or self.root
        self.champion_pt = champion_pt
        self.cfg = dict(games_per_iter=games_per_iter, parallel=parallel, sims=sims, workers=workers, lr=lr,
                        window_games=window_games, train_ratio=train_ratio, batch=batch, seed=seed)
        self.smoke = dict(games_per_iter=smoke_games, parallel=smoke_games, sims=smoke_sims, batch=32)

    # --- data ----------------------------------------------------------------------------------------------
    def export_matches(self, out_dir: Path) -> dict:
        """Filtered human matches. With DATABASE_URL set they come from Postgres through the learn-from-humans export
        (apps/web/scripts/export-human.ts: read only, human and owner traffic, daily cap, weights, holdout). Without it, from the local
        PGlite database (read-only copy); a database that does not exist yields zero matches."""
        out_dir.mkdir(parents=True, exist_ok=True)
        if os.environ.get("DATABASE_URL"):
            return self.export_postgres(out_dir)
        script = self.root / "apps" / "web" / "scripts" / "export-matches.ts"
        db = common_root() / ".data" / "pglite"
        if not db.exists():
            summary = {"game": "four", "source": str(db), "total": 0, "kept": 0, "rejected": {}, "humanMatches": 0,
                       "startPositions": 0, "note": "no local database"}
            (out_dir / "matches.jsonl").write_text("")
            (out_dir / "starts.json").write_text(json.dumps({"game": "four", "positions": []}) + "\n")
            (out_dir / "summary.json").write_text(json.dumps(summary) + "\n")
            return summary
        p = subprocess.run([find_bun(), str(script), "--game", "four", "--out", str(out_dir), "--db", str(db)],
                           capture_output=True, text=True, timeout=600, cwd=self.root)
        if p.returncode != 0:
            raise RuntimeError(f"export-matches failed: {p.stderr.strip()[-500:]}")
        return json.loads((out_dir / "summary.json").read_text())

    def export_postgres(self, out_dir: Path) -> dict:
        """The new export, laid out the way train_challenger reads it: matches.jsonl and starts.json here, plus holdout.jsonl and
        holdout-starts.json for the holdout gate."""
        raw = human_root()  # data/human/four/ in the common root: the canonical, gitignored copy of the latest export
        s = export_human("four", raw)
        src = raw / "four"
        for name in ("matches.jsonl", "starts.json", "holdout.jsonl", "holdout-starts.json", "summary.json"):
            shutil.copyfile(src / name, out_dir / (name if name != "summary.json" else "export-summary.json"))
        summary = {"game": "four", "source": "postgres (read only)", "total": s["total"], "kept": s["kept"], "rejected": s["rejected"],
                   "humanMatches": s["training"], "holdoutMatches": s["holdout"], "idsSha256": s["idsSha256"],
                   "startPositions": len(json.loads((out_dir / "starts.json").read_text())["positions"]),
                   "note": "weights: wins and draws against Hard and Champion count most; Easy counts 0"}
        (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        return summary

    # --- training --------------------------------------------------------------------------------------------
    def champion_source(self, reg: dict) -> Path:
        if self.champion_pt:
            return self.champion_pt
        champ = reg["champion"]
        lineage = runs_dir() / "retrain" / "four" / champ / "champion.pt"
        if lineage.exists():
            return lineage
        snap = reg["levels"]["champion"]["config"].get("snapshot")
        pt = runs_dir() / "four-az" / "snapshots" / f"{snap}.pt"
        if not snap or not pt.exists():
            raise FileNotFoundError(f"the champion {champ} has no .pt to continue from (looked for {lineage} and {pt})")
        return pt

    def train_challenger(self, *, work_dir: Path, budget_minutes: float, data_dir: Path, smoke: bool, reg: dict,
                         log=print) -> Challenger:
        src = self.champion_source(reg)
        ck = torch.load(src, map_location="cpu", weights_only=True)
        blocks, channels = ck["arch"]
        c = {**self.cfg, **(self.smoke if smoke else {})}
        torch.set_num_threads(max(1, c["workers"]))
        tr = RetrainTrainer(blocks, channels, c["lr"], c["window_games"], c["seed"])
        tr.load_weights(src)
        start_steps = tr.steps

        starts = data_dir / "starts.json"
        positions = json.loads(starts.read_text())["positions"] if starts.exists() else []
        extra = ["--starts", str(starts), "--start-share", str(START_SHARE)] if positions else []
        matches = [json.loads(line) for line in (data_dir / "matches.jsonl").read_text().splitlines() if line.strip()] \
            if (data_dir / "matches.jsonl").exists() else []
        used = sum(1 for m in matches if positions_of(m["moves"]) > 0 and m.get("weight", 1) > 0) if positions else 0

        deadline = time.monotonic() + budget_minutes * 60
        rounds, from_human = 0, 0
        while True:
            row = tr.round(c["games_per_iter"], c["parallel"], c["sims"], c["train_ratio"], c["batch"],
                           seed=c["seed"] * 100_003 + rounds + 1, workers=c["workers"] if not smoke else 1, extra=extra)
            rounds += 1
            from_human += row["from_human_starts"]
            log(f"retrain four: round {rounds} " + json.dumps(row))
            if smoke or time.monotonic() >= deadline:
                break

        work_dir.mkdir(parents=True, exist_ok=True)
        pt = work_dir / "champion.pt"
        torch.save({"model": tr.model.state_dict(), "games_total": tr.games_total, "steps": tr.steps, "arch": [blocks, channels]}, pt)
        onnx = work_dir / "champion.onnx"
        sha = tr.export(onnx)
        return Challenger(
            artifacts={"champion": onnx}, sha256={"champion": sha}, trained_steps=tr.steps,
            human_matches_used=used,
            notes={"rounds": rounds, "selfPlayGames": tr.games_total, "gamesFromHumanStarts": from_human,
                   "startPositions": len(positions), "fineTunedSteps": tr.steps - start_steps, "source": str(src), "sims": c["sims"]},
        )

    # --- gate ------------------------------------------------------------------------------------------------
    def champion_onnx(self, reg: dict) -> Path:
        return self.root / champion_artifact(reg, "champion")

    def run_gate(self, *, challenger: Challenger, reg: dict, games: int, sims: int, processes: int, starts: Path | None = None,
                 seed_base: int | None = None) -> dict:
        """Plays the challenger against the champion through the TS harness and returns its JSON line ({points, n, sims, runtime, bySeat}).
        With `starts` (a JSON file of positions people reached) the games begin from those positions."""
        script = self.gate_root / "packages" / "agents" / "src" / "measure" / "four-gate.ts"
        champion = self.champion_onnx(reg)
        cmd = [find_bun(), str(script), "--challenger", str(challenger.artifacts["champion"]), "--champion", str(champion),
               "--games", str(games), "--sims", str(sims), "--processes", str(processes)]
        if starts is not None:
            cmd += ["--starts", str(starts)]
        if seed_base is not None:
            cmd += ["--seed-base", str(seed_base)]
        p = subprocess.run(cmd, capture_output=True, text=True, cwd=self.root, timeout=6 * 3600, stdin=subprocess.DEVNULL)
        if p.returncode != 0:
            raise RuntimeError(f"gate games failed: {p.stderr.strip()[-500:]}")
        out = json.loads(p.stdout.strip().splitlines()[-1])
        out["opponent"] = str(champion.relative_to(self.root)) if champion.is_relative_to(self.root) else str(champion)
        return out

    def play_gate(self, *, challenger: Challenger, reg: dict, games: int, sims: int, processes: int) -> tuple[float, int, dict]:
        out = self.run_gate(challenger=challenger, reg=reg, games=games, sims=sims, processes=processes)
        return float(out["points"]), int(out["n"]), {"sims": out["sims"], "harness": out["runtime"], "opponent": out["opponent"]}
