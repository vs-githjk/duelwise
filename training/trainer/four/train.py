"""AlphaZero-lite for Four in a Row. Bun plays batches of self-play games with PUCT search
(packages/core/src/bridge/selfplay-host.ts); this process answers every leaf evaluation with the current
network, turns the finished games into replay rows and trains on a window of recent games.

Run by the supervisor as job `four-az` (training/jobs/four-az.json):
    scripts/py -m trainer.four.train --resume
Checkpoints (atomic, resumable) every 15 minutes; a model snapshot (.pt and .onnx) every 1,000 self-play games."""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from ..bridge import BridgeError, SelfPlayDriver, _main_ts, find_bun
from ..checkpoint import load_latest, save_checkpoint
from ..export_onnx import export_onnx
from ..jobs import heartbeat
from ..paths import resolve_runs_path, runs_dir, worktree_root
from .board import COLS, OBS_SIZE, PLANES, ROWS
from .net import AZNet
from .replay_buffer import ReplayBuffer

SAMPLE = torch.zeros(2, PLANES, ROWS, COLS)


class FourTrainer:
    def __init__(self, blocks: int = 5, channels: int = 64, lr: float = 1e-3, weight_decay: float = 1e-4,
                 window_games: int = 50_000, seed: int = 0):
        torch.manual_seed(seed)
        self.rng = np.random.default_rng(seed)
        self.model = AZNet(blocks, channels)
        self.opt = torch.optim.AdamW(self.model.parameters(), lr=lr, weight_decay=weight_decay)
        self.buffer = ReplayBuffer(window_games)
        self.steps = 0
        self.games_total = 0
        self.iterations = 0
        self.evals = 0
        self.restarts = 0  # bridge processes that died and were replaced (T12b)
        self._lock = threading.Lock()
        self.live_procs: set = set()  # running self-play host processes, for tests that kill one

    # --- self-play -------------------------------------------------------------------------------
    def evaluate(self, batch: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        self.model.eval()
        with torch.inference_mode():
            logits, value = self.model(torch.from_numpy(np.array(batch, dtype=np.float32)).reshape(-1, PLANES, ROWS, COLS))
        with self._lock:
            self.evals += batch.shape[0]
        return logits.numpy(), value.numpy()

    def _worker(self, games: int, parallel: int, sims: int, seed: int, extra: list[str], max_restarts: int,
                fn) -> list[dict]:
        """Plays `games` games on one self-play host. A host that dies is replaced and only the games it had
        not finished are replayed, so a bridge failure never loses the iteration (T12b)."""
        done: list[dict] = []
        attempt = 0
        while len(done) < games:
            want = games - len(done)
            cmd = [find_bun(), str(_main_ts()), "--game", "four", "--mode", "selfplay", "--n", str(min(parallel, want)),
                   "--games", str(want), "--sims", str(sims), "--seed", str(seed + attempt * 1_000_003),
                   "--flush", "8", *extra]
            driver = SelfPlayDriver("four", min(parallel, want), sims, fn, cmd=cmd, on_start=self.live_procs.add)
            try:
                done += driver.run()
            except BridgeError as e:
                done += driver.collected
                attempt += 1
                with self._lock:
                    self.restarts += 1
                print(f"four-az: self-play host died ({str(e)[:200]}); restart {attempt}/{max_restarts}, "
                      f"{len(done)}/{games} games kept", flush=True)
                if attempt > max_restarts:
                    raise
                time.sleep(1.0)
            finally:
                self.live_procs.discard(driver.proc)
        return done[:games]

    def selfplay(self, games: int, parallel: int, sims: int, seed: int, extra: list[str] | None = None,
                 workers: int = 1, max_restarts: int = 20) -> list[dict]:
        """`games` self-play games across `workers` Bun hosts (one thread each), `parallel` games in flight in total."""
        last = [0.0]

        def fn(batch: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
            now = time.monotonic()
            if now - last[0] > 2.0:
                last[0] = now
                heartbeat()
            return self.evaluate(batch)

        workers = max(1, min(workers, games))
        shares = [games // workers + (1 if i < games % workers else 0) for i in range(workers)]
        par = max(1, math.ceil(parallel / workers))
        if workers == 1:
            return self._worker(games, parallel, sims, seed, extra or [], max_restarts, fn)
        with ThreadPoolExecutor(workers) as pool:
            futs = [pool.submit(self._worker, n, par, sims, seed + i * 7_000_003, extra or [], max_restarts, fn)
                    for i, n in enumerate(shares)]
            return [g for f in futs for g in f.result()]

    # --- learning --------------------------------------------------------------------------------
    def losses(self, x: torch.Tensor, pi: torch.Tensor, z: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        logits, value = self.model(x)
        policy_loss = -(pi * F.log_softmax(logits, dim=1)).sum(dim=1).mean()
        value_loss = F.mse_loss(value, z)
        return policy_loss, value_loss

    def train_steps(self, steps: int, batch: int = 256) -> tuple[float, float]:
        """Mean (policy, value) loss over `steps` minibatches from the replay window."""
        self.model.train()
        ps, vs = [], []
        for _ in range(steps):
            x, pi, z = self.buffer.sample(batch, self.rng)
            pl, vl = self.losses(torch.from_numpy(x), torch.from_numpy(pi), torch.from_numpy(z))
            self.opt.zero_grad()
            (pl + vl).backward()
            self.opt.step()
            self.steps += 1
            ps.append(pl.item())
            vs.append(vl.item())
        return float(np.mean(ps)), float(np.mean(vs))

    def fixed_batch_loss(self, x: np.ndarray, pi: np.ndarray, z: np.ndarray) -> float:
        self.model.eval()
        with torch.no_grad():
            pl, vl = self.losses(torch.from_numpy(x), torch.from_numpy(pi), torch.from_numpy(z))
        return float(pl + vl)

    def overfit(self, x: np.ndarray, pi: np.ndarray, z: np.ndarray, steps: int) -> None:
        self.model.train()
        xt, pit, zt = torch.from_numpy(x), torch.from_numpy(pi), torch.from_numpy(z)
        for _ in range(steps):
            pl, vl = self.losses(xt, pit, zt)
            self.opt.zero_grad()
            (pl + vl).backward()
            self.opt.step()

    def iteration(self, games: int, parallel: int, sims: int, train_ratio: float, batch: int, seed: int,
                  min_positions: int = 0, workers: int = 1, train_threads: int | None = None) -> dict:
        """One round: self-play `games` games, add them to the window, train. Returns the metrics row."""
        t0 = time.monotonic()
        restarts0 = self.restarts
        if train_threads is not None:  # one torch thread per self-play worker, the full budget for the learner
            torch.set_num_threads(max(1, workers))
        finished = self.selfplay(games, parallel, sims, seed, workers=workers)
        if train_threads is not None:
            torch.set_num_threads(train_threads)
        t1 = time.monotonic()
        added = self.buffer.add_games(finished)
        self.games_total += len(finished)
        steps = 0
        pl = vl = float("nan")
        if added and self.buffer.positions >= max(min_positions, 1):
            steps = max(1, math.ceil(added * train_ratio / batch))
            pl, vl = self.train_steps(steps, batch)
        self.iterations += 1
        t2 = time.monotonic()
        return {
            "iteration": self.iterations, "games": len(finished), "games_total": self.games_total, "positions_added": added,
            "window_games": self.buffer.games, "steps": steps, "policy_loss": pl, "value_loss": vl,
            "workers": workers, "bridge_restarts": self.restarts - restarts0,
            "selfplay_s": round(t1 - t0, 1), "train_s": round(t2 - t1, 1),
            "games_per_hour": round(len(finished) / max(t1 - t0, 1e-9) * 3600),
            "draws": sum(1 for g in finished if g["winner"] is None and not g["truncated"]),
            "mean_plies": round(float(np.mean([len(g["moves"]) for g in finished])), 1) if finished else 0,
        }

    # --- persistence -----------------------------------------------------------------------------
    def extra(self) -> dict:
        return {"games_total": self.games_total, "iterations": self.iterations, "arch": [self.model.blocks, self.model.channels]}

    def save(self, ckpt_dir: Path, keep_last: int = 3) -> Path:
        ckpt_dir.mkdir(parents=True, exist_ok=True)
        self.buffer.save(ckpt_dir / "buffer.npz")
        return save_checkpoint(ckpt_dir, self.steps, self.model, self.opt, extra=self.extra(), keep_last=keep_last)

    def resume(self, ckpt_dir: Path, load_buffer: bool = True) -> bool:
        info = load_latest(ckpt_dir, self.model, self.opt)
        if info is None:
            return False
        self.steps = info["step"]
        extra = info["extra"] or {}
        self.games_total, self.iterations = int(extra.get("games_total", 0)), int(extra.get("iterations", 0))
        buf = ckpt_dir / "buffer.npz"
        if load_buffer and buf.exists():
            try:
                self.buffer = ReplayBuffer.load(buf, self.buffer.window_games)
            except Exception as e:  # a torn buffer file only costs the window, never the model
                print(f"four-az: could not load {buf}: {type(e).__name__}: {e}", flush=True)
        return True

    def export(self, path: Path | str) -> str:
        """ONNX with outputs (policy logits (N, 7), value (N,)); returns the sha256."""
        return export_onnx(self.model.cpu(), SAMPLE, path)

    def snapshot(self, snap_dir: Path) -> Path:
        snap_dir.mkdir(parents=True, exist_ok=True)
        stem = f"snap-{self.games_total:08d}"
        torch.save({"model": self.model.state_dict(), "games_total": self.games_total, "steps": self.steps,
                    "arch": [self.model.blocks, self.model.channels]}, snap_dir / f"{stem}.pt")
        self.export(snap_dir / f"{stem}.onnx")
        return snap_dir / stem


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--ckpt-dir", default=os.environ.get("TRAINER_CKPT_DIR"))
    ap.add_argument("--run-dir", default=os.environ.get("TRAINER_RUN_DIR"))
    ap.add_argument("--games-per-iter", type=int, default=256)
    ap.add_argument("--parallel", type=int, default=256)
    ap.add_argument("--sims", type=int, default=200)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--train-ratio", type=float, default=4.0, help="times each new position is sampled per iteration")
    ap.add_argument("--window-games", type=int, default=50_000)
    ap.add_argument("--snapshot-every", type=int, default=1000)
    ap.add_argument("--checkpoint-seconds", type=float, default=900)
    ap.add_argument("--max-minutes", type=float, default=0, help="stop cleanly (exit 0) after this long; 0 = until stopped")
    ap.add_argument("--max-iterations", type=int, default=0)
    ap.add_argument("--threads", type=int, default=2, help="torch threads for the learner")
    ap.add_argument("--workers", type=int, default=2, help="self-play hosts running at once (one per CPU slot)")
    ap.add_argument("--blocks", type=int, default=5)
    ap.add_argument("--channels", type=int, default=64)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--export", default=None, help="write the model to this ONNX path before exiting")
    ap.add_argument("--export-only", default=None, help="load the latest checkpoint, write this ONNX path, exit")
    a = ap.parse_args(argv)

    torch.set_num_threads(a.threads)
    run_dir = Path(a.run_dir) if a.run_dir else resolve_runs_path("runs/four-az", runs_dir())
    ckpt_dir = Path(a.ckpt_dir) if a.ckpt_dir else run_dir / "ckpt"
    snap_dir, metrics = run_dir / "snapshots", run_dir / "metrics.jsonl"
    run_dir.mkdir(parents=True, exist_ok=True)

    tr = FourTrainer(a.blocks, a.channels, a.lr, window_games=a.window_games, seed=a.seed)
    resumed = tr.resume(ckpt_dir) if (a.resume or a.export_only) else False
    if a.export_only:
        if not resumed:
            print("four-az: no checkpoint to export", flush=True)
            return 1
        print(f"four-az: exported sha256 {tr.export(a.export_only)}", flush=True)
        return 0
    print(f"four-az: {'resumed at step %d, %d games' % (tr.steps, tr.games_total) if resumed else 'fresh start'}; "
          f"net {a.blocks}x{a.channels}, {sum(p.numel() for p in tr.model.parameters())} params", flush=True)

    stop = {"flag": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.update(flag=True))
    started = time.monotonic()
    last_ckpt = started
    code = 0
    try:
        while not stop["flag"]:
            if a.max_minutes and (time.monotonic() - started) / 60 >= a.max_minutes:
                break
            if a.max_iterations and tr.iterations >= a.max_iterations:
                break
            before = tr.games_total
            row = tr.iteration(a.games_per_iter, a.parallel, a.sims, a.train_ratio, a.batch, seed=a.seed * 100_003 + tr.iterations + 1,
                               min_positions=a.batch, workers=a.workers, train_threads=a.threads)
            if a.snapshot_every and tr.games_total // a.snapshot_every > before // a.snapshot_every:
                row["snapshot"] = tr.snapshot(snap_dir).name
            with open(metrics, "a") as f:
                f.write(json.dumps(row) + "\n")
            print("four-az: " + json.dumps(row), flush=True)
            heartbeat()
            if time.monotonic() - last_ckpt >= a.checkpoint_seconds:
                tr.save(ckpt_dir)
                last_ckpt = time.monotonic()
    except Exception as e:
        print(f"four-az: stopping on {type(e).__name__}: {e}", flush=True)
        code = 1
    finally:
        tr.save(ckpt_dir)
    if a.export:
        print(f"four-az: exported sha256 {tr.export(a.export)}", flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
