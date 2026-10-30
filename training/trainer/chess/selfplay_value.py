"""Self-play fine-tune of the chess value net (job `chess-sp`), producing CHALLENGER candidates only.

The Bun bridge (packages/core/src/bridge/chess-selfplay.ts) plays whole games of the Champion search against itself on
the current weights (value.bin) and returns, for every searched position, its features, the search score and who moved.
Training targets blend the game outcome and the search score (both for the side to move):

    target = lam * outcome + (1 - lam) * sigmoid(score / 100)        outcome 1 / 0.5 / 0; a cut-short game has none (lam 0)

The net is fine-tuned on a rolling buffer of those positions with binary cross-entropy. Every few iterations the
current weights are written as a numbered candidate under <run-dir>/candidates/vNNNN/ with meta.json saying
`promoted: false`. Nothing here ever writes the shipped model folder: a candidate becomes the Champion only through
the gate (T50).

    scripts/py -m trainer.chess.selfplay_value --max-minutes 330 [--resume]
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from ..bridge import BridgeError, SelfPlayDriver, _main_ts, find_bun
from ..checkpoint import load_latest, save_checkpoint
from ..jobs import heartbeat
from ..paths import resolve_runs_path, runs_dir
from .data import MAX_ACTIVE, SPARSE_FEATURES
from .export import export_value, load_value, write_value_bin
from .value_net import ValueNet

SCORE_CLAMP = 8.0  # logits; a forced mate (+-20000 / 100) is clamped here, sigmoid(8) = 0.9997
PAD = -1


def play_games(value_bin: Path | str, *, games: int, nodes: int = 400, seed: int = 0, max_plies: int = 160,
               open_plies: int = 4, explore_plies: int = 12, eps: float = 0.1) -> list[dict]:
    """Self-play games through the bridge on the weights in `value_bin` (absolute path). Deterministic in `seed`."""
    cmd = [find_bun(), str(_main_ts()), "--game", "chess", "--mode", "selfplay", "--value", str(Path(value_bin).resolve()),
           "--games", str(games), "--seed", str(seed), "--nodes", str(nodes), "--max-plies", str(max_plies),
           "--open-plies", str(open_plies), "--explore-plies", str(explore_plies), "--eps", str(eps)]

    def no_eval(_batch):
        raise RuntimeError("the chess self-play host searches on its own weights and never asks for an evaluation")

    return SelfPlayDriver("chess", games, nodes, no_eval, cmd=cmd).run()


def play_with_retry(stop: dict, *, max_restarts: int = 5, play=play_games, **kw) -> list[dict] | None:
    """play_games, replaying the batch with a fresh seed when the Bun host dies (T12b precedent). Returns None when the
    stop flag is set: a SIGTERM to the process group kills the hosts too, so that BridgeError is a stop, not an error."""
    seed = kw.pop("seed", 0)
    attempt = 0
    while True:
        if stop["flag"]:
            return None
        try:
            return play(seed=seed + attempt * 1_000_003, **kw)
        except BridgeError as e:
            if stop["flag"]:
                return None
            attempt += 1
            print(f"chess-sp: self-play host died ({str(e)[:200]}); restart {attempt}/{max_restarts}", flush=True)
            if attempt > max_restarts:
                raise
            time.sleep(1.0)


def next_version(cand_dir: Path | str, counter: int = 0) -> int:
    """One past the highest of the checkpoint's counter and every candidates/vNNNN folder on disk, so a resume from an
    older checkpoint never overwrites a candidate that was already written."""
    top = counter
    d = Path(cand_dir)
    if d.is_dir():
        for p in d.iterdir():
            if p.is_dir() and p.name[:1] == "v" and p.name[1:].isdigit():
                top = max(top, int(p.name[1:]))
    return top + 1


def build_sparse_targets(games: list[dict], lam: float) -> tuple[np.ndarray, np.ndarray]:
    """Games -> (idx (N, 32) int16 padded with -1, target (N,) float32) for every searched position."""
    idx_rows: list[list[int]] = []
    targets: list[float] = []
    for g in games:
        for feats, score, seat in zip(g["feats"], g["scores"], g["seats"]):
            soft = 1.0 / (1.0 + np.exp(-float(np.clip(score / 100.0, -SCORE_CLAMP, SCORE_CLAMP))))
            if g["truncated"]:
                t = soft
            else:
                won = 0.5 if g["winner"] is None else (1.0 if g["winner"] == seat else 0.0)
                t = lam * won + (1.0 - lam) * soft
            row = list(feats)[:MAX_ACTIVE]
            idx_rows.append(row + [PAD] * (MAX_ACTIVE - len(row)))
            targets.append(t)
    if not idx_rows:
        return np.zeros((0, MAX_ACTIVE), dtype=np.int16), np.zeros(0, dtype=np.float32)
    return np.asarray(idx_rows, dtype=np.int16), np.asarray(targets, dtype=np.float32)


def densify(idx: np.ndarray) -> torch.Tensor:
    """Padded feature indices (N, 32) -> multi-hot (N, 768) float32."""
    i = torch.from_numpy(idx.astype(np.int64))
    x = torch.zeros(i.shape[0], SPARSE_FEATURES + 1)
    x.scatter_(1, torch.where(i < 0, SPARSE_FEATURES, i), 1.0)
    return x[:, :SPARSE_FEATURES]


def build_targets(games: list[dict], lam: float) -> tuple[torch.Tensor, torch.Tensor]:
    idx, t = build_sparse_targets(games, lam)
    return densify(idx), torch.from_numpy(t)


def finetune(model: ValueNet, x, t, *, steps: int, lr: float, batch: int, seed: int = 0, opt: torch.optim.Optimizer | None = None,
             stop=None) -> list[float]:
    """`steps` Adam steps on random batches of (x, t). `x` is dense (N, 768) float or padded indices (N, 32) int16.
    Returns the loss of every step run (shorter than `steps` only when `stop()` turns true)."""
    sparse = isinstance(x, np.ndarray)
    tt = torch.as_tensor(t, dtype=torch.float32)
    n = len(tt)
    if n == 0:
        return []
    opt = opt or torch.optim.Adam(model.parameters(), lr=lr)
    for g in opt.param_groups:
        g["lr"] = lr
    rng = np.random.default_rng(seed)
    model.train()
    losses: list[float] = []
    for _ in range(steps):
        if stop is not None and stop():
            break
        pick = rng.integers(0, n, size=min(batch, n)) if batch < n else np.arange(n)
        xb = densify(x[pick]) if sparse else x[torch.from_numpy(pick)]
        loss = F.binary_cross_entropy_with_logits(model.logit(xb), tt[torch.from_numpy(pick)])
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        losses.append(loss.item())
    return losses


def write_candidate(model: ValueNet, cand_dir: Path | str, *, version: int, meta: dict) -> Path:
    """Writes <cand_dir>/vNNNN/{value.bin,value.onnx,meta.json}. Never promotes: meta says promoted false, gate T50."""
    out = Path(cand_dir) / f"v{version:04d}"
    out.mkdir(parents=True, exist_ok=True)
    sha = export_value(model, out / "value.onnx", out / "value.bin")
    body = {**meta, "version": version, "promoted": False, "gate": "T50", "onnxSha256": sha}
    (out / "meta.json").write_text(json.dumps(body, indent=1, sort_keys=True) + "\n")
    return out


def _start_model(ckpt_dir: Path, base_ckpt_dir: Path, resume: bool, lr: float) -> tuple[ValueNet, torch.optim.Optimizer, dict]:
    """This job's own checkpoint (weights, Adam moments, counters) when resuming, else the trained chess-value net."""
    if resume:
        net = load_value(ckpt_dir)
        if net is not None:
            opt = torch.optim.Adam(net.parameters(), lr=lr)
            info = load_latest(ckpt_dir, net, opt)
            return net, opt, dict(info["extra"] or {})
    net = load_value(base_ckpt_dir)
    if net is None:
        raise RuntimeError(f"no trained chess-value checkpoint in {base_ckpt_dir}: run job chess-value first")
    return net, torch.optim.Adam(net.parameters(), lr=lr), {}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--ckpt-dir", default=os.environ.get("TRAINER_CKPT_DIR"))
    ap.add_argument("--run-dir", default=os.environ.get("TRAINER_RUN_DIR"))
    ap.add_argument("--base-ckpt-dir", default=None, help="chess-value checkpoints to start from (default runs/chess-value/ckpt)")
    ap.add_argument("--max-minutes", type=float, default=330.0)
    ap.add_argument("--max-iters", type=int, default=0)
    ap.add_argument("--workers", type=int, default=2, help="parallel bridge processes (match the job's cpuSlots)")
    ap.add_argument("--games-per-worker", type=int, default=4)
    ap.add_argument("--nodes", type=int, default=400)
    ap.add_argument("--max-plies", type=int, default=160)
    ap.add_argument("--lam", type=float, default=0.5)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--batch", type=int, default=1024)
    ap.add_argument("--steps-per-iter", type=int, default=100)
    ap.add_argument("--buffer", type=int, default=200_000, help="positions kept (newest)")
    ap.add_argument("--candidate-every", type=int, default=10, help="iterations between candidate versions")
    ap.add_argument("--checkpoint-seconds", type=float, default=900.0)
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args(argv)
    torch.set_num_threads(a.threads)
    run_dir = Path(a.run_dir) if a.run_dir else resolve_runs_path("runs/chess-sp", runs_dir())
    ckpt_dir = Path(a.ckpt_dir) if a.ckpt_dir else run_dir / "ckpt"
    base_dir = Path(a.base_ckpt_dir) if a.base_ckpt_dir else resolve_runs_path("runs/chess-value/ckpt", runs_dir())
    work = run_dir / "work"
    work.mkdir(parents=True, exist_ok=True)
    stop = {"flag": False}
    code, started, finished = 0, False, False
    old = signal.signal(signal.SIGTERM, lambda *_: stop.update(flag=True))
    try:
        model, opt, extra = _start_model(ckpt_dir, base_dir, a.resume, a.lr)
        it, version, prior = int(extra.get("iter", 0)), int(extra.get("version", 0)), float(extra.get("elapsed_s", 0.0))
        games_total, positions = int(extra.get("games", 0)), int(extra.get("positions", 0))
        buf_x = np.zeros((0, MAX_ACTIVE), dtype=np.int16)
        buf_t = np.zeros(0, dtype=np.float32)
        t0 = last_ckpt = time.monotonic()
        budget = a.max_minutes * 60
        print(f"chess-sp: start at iter {it}, {prior:.0f}s of {budget:.0f}s, workers {a.workers}", flush=True)
        heartbeat()

        def elapsed() -> float:
            return prior + time.monotonic() - t0

        def save(done: bool) -> None:
            save_checkpoint(ckpt_dir, it, model, opt, keep_last=3,
                            extra={"iter": it, "version": version, "elapsed_s": elapsed(), "arch": model.arch(), "done": done,
                                   "games": games_total, "positions": positions})

        started = True
        last_loss = float("nan")
        while not stop["flag"] and elapsed() < budget and not (a.max_iters and it >= a.max_iters):
            cur = work / "value-cur.bin"
            write_value_bin(model.cpu(), cur)
            seeds = [a.seed * 100003 + it * 64 + w for w in range(a.workers)]
            with ThreadPoolExecutor(max_workers=a.workers) as pool:
                batches = list(pool.map(lambda s: play_with_retry(stop, value_bin=cur, games=a.games_per_worker, nodes=a.nodes,
                                                                  seed=s, max_plies=a.max_plies), seeds))
            if stop["flag"] or any(b is None for b in batches):
                break  # stopped mid self-play: drop the partial iteration, keep the model and counters
            games = [g for b in batches for g in b]
            heartbeat()
            gx, gt = build_sparse_targets(games, a.lam)
            games_total += len(games)
            positions += len(gt)
            buf_x = np.concatenate([buf_x, gx])[-a.buffer:]
            buf_t = np.concatenate([buf_t, gt])[-a.buffer:]
            losses = finetune(model, buf_x, buf_t, steps=a.steps_per_iter, lr=a.lr, batch=a.batch, seed=a.seed + it, opt=opt,
                              stop=lambda: stop["flag"])
            it += 1
            last_loss = float(np.mean(losses)) if losses else last_loss
            decisive = sum(1 for g in games if g["winner"] is not None)
            row = {"iter": it, "elapsed_s": round(elapsed()), "games": len(games), "decisive": decisive,
                   "plies": int(sum(len(g["moves"]) for g in games)), "buffer": len(buf_t), "loss": round(last_loss, 5)}
            print("chess-sp: " + json.dumps(row), flush=True)
            with open(run_dir / "metrics.jsonl", "a") as f:
                f.write(json.dumps(row) + "\n")
            heartbeat()
            if it % a.candidate_every == 0 and not stop["flag"]:
                version = next_version(run_dir / "candidates", version)
                out = write_candidate(model, run_dir / "candidates", version=version,
                                      meta={"iter": it, "games": games_total, "positions": positions, "lam": a.lam, "nodes": a.nodes,
                                            "lr": a.lr, "loss": last_loss, "base": str(base_dir)})
                print(f"chess-sp: candidate {out}", flush=True)
            if time.monotonic() - last_ckpt >= a.checkpoint_seconds:
                save(False)
                last_ckpt = time.monotonic()
        version = next_version(run_dir / "candidates", version)
        write_candidate(model, run_dir / "candidates", version=version,
                        meta={"iter": it, "games": games_total, "positions": positions, "lam": a.lam, "nodes": a.nodes,
                              "lr": a.lr, "loss": last_loss, "base": str(base_dir), "final": True})
        finished = not stop["flag"]
    except Exception as e:
        print(f"chess-sp: stopping on {type(e).__name__}: {e}", flush=True)
        code = 1
    finally:
        if started:
            save(finished)  # any exit keeps the model, optimizer and counters (four/train.py precedent)
        signal.signal(signal.SIGTERM, old)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
