"""Throughput benchmark for the air hockey (puck) env through the real Bun bridge (P3).

    scripts/py -m trainer.bench_puck --out /abs/path/plan/bench/P3-puck.json [--point-seconds 10]

Measures (1) env steps per second over the bridge (1 to 3 Bun processes, 64/128/256 envs each, random bin
actions, level hard), (2) the same at the best point with seat 1 played by the scripted bots (the league mix),
(3) the cost of one PPO minibatch update and one rollout inference call for the puck net (23 features, 11 + 9
logits plus value), (4) measured end to end PPO decision steps per second on 2 CPU slots, and writes step
budgets for the schedule. An "env step" is one decision of every env in a batch (frame skip 2, both seats).
"""

from __future__ import annotations

import argparse
import json
import statistics
import threading
import time
from pathlib import Path

import numpy as np

from .bridge import BridgeEnv

OBS = 23
NVEC = (11, 9)
LOGITS = sum(NVEC)
HIDDEN = 256
MINIBATCH = 4096
EPOCHS = 4
ROLLOUT_STEPS = 128
CPU_SLOTS = 2
BOT_KINDS = 5


def _pool(envs: int, bots: bool, seed: int) -> list[np.ndarray]:
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(64):
        a = np.stack([rng.integers(0, NVEC[0], (envs, 2)), rng.integers(0, NVEC[1], (envs, 2))], axis=-1).astype(np.int32)
        if bots:
            a[:, 1, 0] = -1 - rng.integers(0, BOT_KINDS, envs)
        out.append(a)
    return out


def bench_env(procs: int, envs_per_proc: int, seconds: float, bots: bool = False, level: str = "hard", seed: int = 0) -> float:
    pools = [_pool(envs_per_proc, bots, seed + p) for p in range(procs)]
    envs = [BridgeEnv("puck", envs_per_proc, seed=seed + 1000 * p, level=level) for p in range(procs)]
    counts = [0] * procs
    stop = threading.Event()
    errors: list[BaseException] = []

    def work(p: int) -> None:
        try:
            env = envs[p]
            env.reset()
            k = 0
            while not stop.is_set():
                env.step(pools[p][k % 64])
                counts[p] += 1
                k += 1
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=work, args=(p,), daemon=True) for p in range(procs)]
    try:
        for t in threads:
            t.start()
        time.sleep(1.5)
        c0, t0 = sum(counts), time.perf_counter()
        time.sleep(seconds)
        c1, t1 = sum(counts), time.perf_counter()
        stop.set()
        for t in threads:
            t.join(timeout=30)
        if errors:
            raise errors[0]
    finally:
        stop.set()
        for e in envs:
            e.close()
    return (c1 - c0) * envs_per_proc / (t1 - t0)


def _net(torch):
    nn = torch.nn
    return nn.Sequential(nn.Linear(OBS, HIDDEN), nn.Tanh(), nn.Linear(HIDDEN, HIDDEN), nn.Tanh(), nn.Linear(HIDDEN, LOGITS + 1))


def _heads(torch, o, a):
    ld = torch.log_softmax(o[:, : NVEC[0]], -1)
    lb = torch.log_softmax(o[:, NVEC[0] : LOGITS], -1)
    return ld.gather(1, a[:, :1]).squeeze(1) + lb.gather(1, a[:, 1:]).squeeze(1)


def bench_update_ms(iters: int = 40, warm: int = 8) -> float:
    import torch

    torch.set_num_threads(CPU_SLOTS)
    torch.manual_seed(0)
    net = _net(torch)
    opt = torch.optim.Adam(net.parameters(), lr=3e-4)
    x = torch.randn(MINIBATCH, OBS)
    adv, old, ret = torch.randn(MINIBATCH), torch.randn(MINIBATCH), torch.randn(MINIBATCH)
    acts = torch.stack([torch.randint(0, NVEC[0], (MINIBATCH,)), torch.randint(0, NVEC[1], (MINIBATCH,))], dim=1)

    def one() -> None:
        o = net(x)
        logp = _heads(torch, o, acts)
        ratio = (logp - old).exp()
        pg = -torch.min(ratio * adv, ratio.clamp(0.8, 1.2) * adv).mean()
        loss = pg + 0.5 * (o[:, LOGITS] - ret).pow(2).mean()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()

    for _ in range(warm):
        one()
    times = []
    for _ in range(iters):
        t0 = time.perf_counter()
        one()
        times.append((time.perf_counter() - t0) * 1000)
    return statistics.median(times)


def bench_infer_ms(batch: int, iters: int = 100) -> float:
    import torch

    torch.set_num_threads(CPU_SLOTS)
    net = _net(torch)
    x = torch.randn(batch, OBS)
    with torch.no_grad():
        for _ in range(10):
            net(x)
        times = []
        for _ in range(iters):
            t0 = time.perf_counter()
            o = net(x)
            torch.distributions.Categorical(logits=o[:, : NVEC[0]]).sample()
            torch.distributions.Categorical(logits=o[:, NVEC[0] : LOGITS]).sample()
            times.append((time.perf_counter() - t0) * 1000)
    return statistics.median(times)


def bench_end_to_end(procs: int, envs_per_proc: int, iterations: int = 4) -> float:
    """Measured PPO iterations on CPU: rollouts from `procs` bridge processes (learner net on seat 0, a second net
    on seat 1), then EPOCHS x minibatch updates. Median learner decision steps per second."""
    import torch

    torch.set_num_threads(CPU_SLOTS)
    torch.manual_seed(0)
    learner, opp, train = _net(torch), _net(torch), _net(torch)
    opt = torch.optim.Adam(train.parameters(), lr=3e-4)
    envs = [BridgeEnv("puck", envs_per_proc, seed=77 + 1000 * p, level="champion") for p in range(procs)]
    obs_now = [e.reset() for e in envs]
    samples = procs * envs_per_proc * ROLLOUT_STEPS
    rates = []

    def rollout(p: int, out: dict) -> None:
        env, obs = envs[p], obs_now[p]
        bo = np.empty((ROLLOUT_STEPS, envs_per_proc, OBS), np.float32)
        ba = np.empty((ROLLOUT_STEPS, envs_per_proc, 2), np.int64)
        br = np.empty((ROLLOUT_STEPS, envs_per_proc), np.float32)
        bv = np.empty((ROLLOUT_STEPS, envs_per_proc), np.float32)
        with torch.no_grad():
            for k in range(ROLLOUT_STEPS):
                xs = torch.from_numpy(obs)
                lo, oo = learner(xs[:, 0]), opp(xs[:, 1])
                a0 = torch.stack([torch.distributions.Categorical(logits=lo[:, : NVEC[0]]).sample(), torch.distributions.Categorical(logits=lo[:, NVEC[0] : LOGITS]).sample()], 1)
                a1 = torch.stack([torch.distributions.Categorical(logits=oo[:, : NVEC[0]]).sample(), torch.distributions.Categorical(logits=oo[:, NVEC[0] : LOGITS]).sample()], 1)
                bo[k], ba[k], bv[k] = obs[:, 0], a0.numpy(), lo[:, LOGITS].numpy()
                obs, rew, _d, _i = env.step(torch.stack([a0, a1], 1).numpy().astype(np.int32))
                br[k] = rew
        obs_now[p] = obs
        adv = np.zeros_like(br)
        last = 0.0
        for k in reversed(range(ROLLOUT_STEPS)):
            last = br[k] + 0.99 * 0.95 * last
            adv[k] = last - bv[k]
        out[p] = (bo.reshape(-1, OBS), ba.reshape(-1, 2), adv.reshape(-1), (adv + bv).reshape(-1))

    try:
        for it in range(iterations + 1):
            t0 = time.perf_counter()
            out: dict = {}
            ths = [threading.Thread(target=rollout, args=(p, out)) for p in range(procs)]
            for t in ths:
                t.start()
            for t in ths:
                t.join()
            x, a, adv, ret = (torch.from_numpy(np.concatenate([out[p][j] for p in range(procs)])) for j in range(4))
            for _ in range(EPOCHS):
                perm = torch.randperm(x.shape[0])
                for s in range(0, x.shape[0], MINIBATCH):
                    idx = perm[s : s + MINIBATCH]
                    o = train(x[idx])
                    loss = -(_heads(torch, o, a[idx]) * adv[idx]).mean() + 0.5 * (o[:, LOGITS] - ret[idx]).pow(2).mean()
                    opt.zero_grad(set_to_none=True)
                    loss.backward()
                    opt.step()
            if it > 0:
                rates.append(samples / (time.perf_counter() - t0))
    finally:
        for e in envs:
            e.close()
    return statistics.median(rates)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--point-seconds", type=float, default=10.0)
    ap.add_argument("--repeats", type=int, default=2, help="runs per grid point; the point value is their median")
    ap.add_argument("--e2e-runs", type=int, default=5)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    grid = []
    for procs in (1, 2, 3):
        for per in (64, 128, 256):
            runs = [bench_env(procs, per, args.point_seconds) for _ in range(args.repeats)]
            v = statistics.median(runs)
            grid.append({"procs": procs, "envsPerProc": per, "value": round(v), "runs": [round(r) for r in runs]})
            print(f"env procs={procs} envs={per}: {v:,.0f} steps/s (runs {[round(r) for r in runs]})", flush=True)
    best2 = max((g for g in grid if g["procs"] <= 2), key=lambda g: g["value"])
    league = bench_env(best2["procs"], best2["envsPerProc"], args.point_seconds, bots=True)
    print(f"league mix (seat 1 scripted bots) at the best 2 slot point: {league:,.0f}", flush=True)
    upd, inf = bench_update_ms(), bench_infer_ms(best2["envsPerProc"])
    e2e = [bench_end_to_end(2, 128) for _ in range(args.e2e_runs)]
    med = statistics.median(e2e)
    print(f"update {upd:.2f} ms, inference {inf:.3f} ms, end to end samples {[round(x) for x in e2e]}", flush=True)
    result = {
        "game": "puck",
        "envStepsPerSec": grid,
        "bestTwoSlotPoint": best2,
        "leagueMixEnvStepsPerSec": round(league),
        "ppoUpdateCpuMs": round(upd, 2),
        "inferenceMsPerRolloutStep": round(inf, 3),
        "measuredEndToEndStepsPerSec": {"min": round(min(e2e)), "median": round(med), "max": round(max(e2e)), "samples": [round(x) for x in e2e]},
        "rateUsedForBudgets": round(med),
        "policy": "MLP 2x256 tanh, 23 features, heads 11 + 9 + value, minibatch 4096, 4 epochs, rollout 128 steps, frame skip 2, CPU, 2 slots, 2 bridge processes of 128 envs, level champion",
        "pointSeconds": args.point_seconds,
        "repeatsPerPoint": args.repeats,
        "pointValue": "median of repeats",
        "caveat": "Measured on a loaded machine (other lanes running), so every figure is a loaded-machine figure. End to end excludes league bookkeeping, snapshot saves and gate runs.",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
