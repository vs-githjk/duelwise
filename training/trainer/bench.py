"""Throughput benchmark for the fighter env and the PPO update (T7).

    scripts/py -m trainer.bench [--point-seconds 20] [--repeats 1] [--out /abs/path/plan/bench/T7.json]

Measures (1) env steps per second over the real bridge (1 to 3 Bun processes, 64/128/256 envs each,
random actions), (2) the cost of one PPO minibatch update (MLP 2x256, minibatch 4096) on CPU and MPS,
(3) the policy inference cost for a rollout step on CPU, and projects end-to-end PPO decision steps
per second on 2 CPU slots. Then it writes the training budgets for the fighter league job.

An "env step" is one decision of every env in a batch (frame skip 4, both seats act). The projection is
conservative: collection and update do not overlap.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import threading
import time
from pathlib import Path

import numpy as np

from .bridge import BridgeEnv

# Observation v2 (R15): 142 view features, the mirrored flag and 19 own-input features; 9 + 8 logits (button head with keep).
OBS_FEATURES_EXPECTED = 162
ACTION_LOGITS = 9 + 8
HIDDEN = 256
MINIBATCH = 4096
EPOCHS = 4
ROLLOUT_STEPS = 128
CPU_SLOTS = 2
MORNING_MINUTES = 100
FULL_HOURS = 10
FULL_PLAN = {"stageA": 60_000_000, "hard": 25_000_000, "medium": 25_000_000, "easy": 10_000_000}


def project_ppo_steps_per_sec(
    env_steps_per_sec: float,
    infer_ms_per_batch: float,
    batch_envs: int,
    update_ms_per_minibatch: float,
    rollout_steps: int = ROLLOUT_STEPS,
    epochs: int = EPOCHS,
    minibatch: int = MINIBATCH,
) -> float:
    """End-to-end decision steps per second for one PPO iteration of batch_envs x rollout_steps."""
    samples = batch_envs * rollout_steps
    collect = samples / env_steps_per_sec + rollout_steps * infer_ms_per_batch / 1000.0
    update = epochs * (samples / minibatch) * update_ms_per_minibatch / 1000.0
    return samples / (collect + update)


def budgets(R: float) -> dict:
    """Step budgets for the fighter league from the measured rate R (decision steps per second)."""
    total = MORNING_MINUTES * 60 * R
    each = round(total / 6)
    morning = {"stageA": round(total * 0.5), "hard": each, "medium": each, "easy": each}
    # The full phase continues from the morning checkpoints and its targets are cumulative, so each full
    # stage must be at least its morning stage. The plan's 60:25:25:10 split is scaled to what
    # FULL_HOURS hours allow at R (up or down), then floored at the morning stage.
    cap = FULL_HOURS * 3600 * R
    scale = cap / sum(FULL_PLAN.values())
    full = {k: max(int(v * scale), morning[k]) for k, v in FULL_PLAN.items()}
    return {"morning": morning, "full": full}


def budget_arithmetic(R: float) -> str:
    total = MORNING_MINUTES * 60 * R
    cap = FULL_HOURS * 3600 * R
    plan_total = sum(FULL_PLAN.values())
    return (
        f"R = {R:,.0f} steps/s. morning: {MORNING_MINUTES} min x 60 x R = {total:,.0f} steps; stageA = 1/2 of it, hard, medium and easy = 1/6 each. "
        f"full: {FULL_HOURS} h x 3600 x R = {cap:,.0f} steps, split 60:25:25:10 (plan numbers sum to {plan_total:,}), so scale = {cap / plan_total:.4f}; "
        f"each full stage is max(split share, its morning stage) because targets are cumulative from the morning checkpoints."
    )


def bench_env(procs: int, envs_per_proc: int, seconds: float, seed: int = 0) -> float:
    rng = np.random.default_rng(seed)
    pool = [
        np.stack([rng.integers(0, 9, (envs_per_proc, 2)), rng.integers(0, 7, (envs_per_proc, 2))], axis=-1).astype(np.int32)
        for _ in range(64)
    ]
    envs = [BridgeEnv("fighter", envs_per_proc, seed=seed + 1000 * p) for p in range(procs)]
    counts = [0] * procs
    stop = threading.Event()
    errors: list[BaseException] = []

    def work(p: int) -> None:
        try:
            env = envs[p]
            env.reset()
            k = 0
            while not stop.is_set():
                env.step(pool[k % len(pool)])
                counts[p] += 1
                k += 1
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=work, args=(p,), daemon=True) for p in range(procs)]
    try:
        for t in threads:
            t.start()
        time.sleep(1.5)  # warm up (JIT, first resets)
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


def _make_net(torch, obs: int):
    nn = torch.nn
    return nn.Sequential(nn.Linear(obs, HIDDEN), nn.Tanh(), nn.Linear(HIDDEN, HIDDEN), nn.Tanh(), nn.Linear(HIDDEN, ACTION_LOGITS + 1))


def bench_update_ms(device: str, iters: int = 40, warm: int = 8) -> float:
    """Median ms for one PPO minibatch step: copy to device, forward, loss, backward, Adam."""
    import torch

    torch.set_num_threads(CPU_SLOTS)
    torch.manual_seed(0)
    net = _make_net(torch, OBS_FEATURES_EXPECTED).to(device)
    opt = torch.optim.Adam(net.parameters(), lr=3e-4)
    x = torch.randn(MINIBATCH, OBS_FEATURES_EXPECTED)
    adv = torch.randn(MINIBATCH)
    old_logp = torch.randn(MINIBATCH)
    ret = torch.randn(MINIBATCH)
    acts = torch.stack([torch.randint(0, 9, (MINIBATCH,)), torch.randint(0, 7, (MINIBATCH,))], dim=1)

    def sync() -> None:
        if device == "mps":
            torch.mps.synchronize()

    def one() -> None:
        xb, ab, advb, oldb, retb = (t.to(device) for t in (x, acts, adv, old_logp, ret))
        out = net(xb)
        logits_d, logits_b, value = out[:, :9], out[:, 9:ACTION_LOGITS], out[:, ACTION_LOGITS]
        ld = torch.log_softmax(logits_d, -1)
        lb = torch.log_softmax(logits_b, -1)
        logp = ld.gather(1, ab[:, :1]).squeeze(1) + lb.gather(1, ab[:, 1:]).squeeze(1)
        ratio = (logp - oldb).exp()
        pg = -torch.min(ratio * advb, ratio.clamp(0.8, 1.2) * advb).mean()
        ent = -((ld.exp() * ld).sum(-1) + (lb.exp() * lb).sum(-1)).mean()
        loss = pg + 0.5 * (value - retb).pow(2).mean() - 0.01 * ent
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()

    for _ in range(warm):
        one()
    sync()
    times = []
    for _ in range(iters):
        t0 = time.perf_counter()
        one()
        sync()
        times.append((time.perf_counter() - t0) * 1000)
    return statistics.median(times)


def bench_infer_ms(batch: int, iters: int = 100) -> float:
    """Median ms for one rollout inference call on CPU with 2 threads (rollouts stay on CPU)."""
    import torch

    torch.set_num_threads(CPU_SLOTS)
    net = _make_net(torch, OBS_FEATURES_EXPECTED)
    x = torch.randn(batch, OBS_FEATURES_EXPECTED)
    with torch.no_grad():
        for _ in range(10):
            net(x)
        times = []
        for _ in range(iters):
            t0 = time.perf_counter()
            out = net(x)
            torch.distributions.Categorical(logits=out[:, :9]).sample()
            torch.distributions.Categorical(logits=out[:, 9:ACTION_LOGITS]).sample()
            times.append((time.perf_counter() - t0) * 1000)
    return statistics.median(times)


def bench_end_to_end(procs: int, envs_per_proc: int, device: str, iterations: int = 4) -> float:
    """Measured PPO iterations: worker threads (one bridge process each) roll out with a learner net and
    an opponent net on CPU, then the main thread runs EPOCHS x minibatch updates on `device`.
    Returns the median decision steps per second (env steps of the learner seat, iteration wall time)."""
    import torch

    torch.set_num_threads(CPU_SLOTS)
    torch.manual_seed(0)
    nn_learner = _make_net(torch, OBS_FEATURES_EXPECTED)
    nn_opp = _make_net(torch, OBS_FEATURES_EXPECTED)
    train_net = _make_net(torch, OBS_FEATURES_EXPECTED).to(device)
    opt = torch.optim.Adam(train_net.parameters(), lr=3e-4)
    envs = [BridgeEnv("fighter", envs_per_proc, seed=77 + 1000 * p) for p in range(procs)]
    for e in envs:
        e.reset()
    obs_now = [e.reset() for e in envs]
    samples_per_iter = procs * envs_per_proc * ROLLOUT_STEPS
    rates = []

    def rollout(p: int, out: dict) -> None:
        env = envs[p]
        obs = obs_now[p]
        buf_obs = np.empty((ROLLOUT_STEPS, envs_per_proc, OBS_FEATURES_EXPECTED), np.float32)
        buf_act = np.empty((ROLLOUT_STEPS, envs_per_proc, 2), np.int64)
        buf_rew = np.empty((ROLLOUT_STEPS, envs_per_proc), np.float32)
        buf_val = np.empty((ROLLOUT_STEPS, envs_per_proc), np.float32)
        with torch.no_grad():
            for k in range(ROLLOUT_STEPS):
                x = torch.from_numpy(obs.reshape(envs_per_proc * 2, OBS_FEATURES_EXPECTED))
                xs = x.view(envs_per_proc, 2, OBS_FEATURES_EXPECTED)
                lo = nn_learner(xs[:, 0])
                oo = nn_opp(xs[:, 1])
                a0 = torch.stack([torch.distributions.Categorical(logits=lo[:, :9]).sample(), torch.distributions.Categorical(logits=lo[:, 9:ACTION_LOGITS]).sample()], 1)
                a1 = torch.stack([torch.distributions.Categorical(logits=oo[:, :9]).sample(), torch.distributions.Categorical(logits=oo[:, 9:ACTION_LOGITS]).sample()], 1)
                buf_obs[k] = obs[:, 0]
                buf_act[k] = a0.numpy()
                buf_val[k] = lo[:, ACTION_LOGITS].numpy()
                obs, rew, _done, _ = env.step(torch.stack([a0, a1], 1).numpy().astype(np.int32))
                buf_rew[k] = rew
        obs_now[p] = obs
        adv = np.zeros_like(buf_rew)
        last = 0.0
        for k in reversed(range(ROLLOUT_STEPS)):
            last = buf_rew[k] + 0.99 * 0.95 * last
            adv[k] = last - buf_val[k]
        out[p] = (buf_obs.reshape(-1, OBS_FEATURES_EXPECTED), buf_act.reshape(-1, 2), adv.reshape(-1), (adv + buf_val).reshape(-1))

    try:
        for it in range(iterations + 1):
            t0 = time.perf_counter()
            out: dict = {}
            threads = [threading.Thread(target=rollout, args=(p, out)) for p in range(procs)]
            for th in threads:
                th.start()
            for th in threads:
                th.join()
            x = torch.from_numpy(np.concatenate([out[p][0] for p in range(procs)]))
            a = torch.from_numpy(np.concatenate([out[p][1] for p in range(procs)]))
            adv = torch.from_numpy(np.concatenate([out[p][2] for p in range(procs)]))
            ret = torch.from_numpy(np.concatenate([out[p][3] for p in range(procs)]))
            n = x.shape[0]
            for _ in range(EPOCHS):
                perm = torch.randperm(n)
                for s in range(0, n, MINIBATCH):
                    idx = perm[s : s + MINIBATCH]
                    xb, ab, advb, retb = (v[idx].to(device) for v in (x, a, adv, ret))
                    o = train_net(xb)
                    ld = torch.log_softmax(o[:, :9], -1)
                    lb = torch.log_softmax(o[:, 9:ACTION_LOGITS], -1)
                    logp = ld.gather(1, ab[:, :1]).squeeze(1) + lb.gather(1, ab[:, 1:]).squeeze(1)
                    loss = -(logp * advb).mean() + 0.5 * (o[:, ACTION_LOGITS] - retb).pow(2).mean()
                    opt.zero_grad(set_to_none=True)
                    loss.backward()
                    opt.step()
            if device == "mps":
                torch.mps.synchronize()
            dt = time.perf_counter() - t0
            if it > 0:  # the first iteration warms everything up
                rates.append(samples_per_iter / dt)
    finally:
        for e in envs:
            e.close()
    return statistics.median(rates)


def run(point_seconds: float, repeats: int = 1, e2e_runs: int = 5, force_device: str | None = None, force_reason: str | None = None) -> dict:
    import torch

    # Other lanes load this machine unpredictably, so the PPO figures are sampled several times, spread
    # over the whole run, and reported as min, median and max.
    cpu_samples = [bench_update_ms("cpu")]
    mps_samples = [bench_update_ms("mps")] if torch.backends.mps.is_available() else []
    # The interim device only decides where the end-to-end samples run; the reported device is chosen below
    # from the medians that are written to ppoUpdate (or forced for a scheduling reason).
    device = force_device or ("mps" if mps_samples and mps_samples[0] < cpu_samples[0] else "cpu")
    points = []
    e2e: list[float] = []
    sweep = [(procs, envs) for procs in (1, 2, 3) for envs in (64, 128, 256)]
    e2e_after = {round((k + 1) * len(sweep) / e2e_runs) - 1 for k in range(e2e_runs)}
    for n, (procs, envs) in enumerate(sweep):
        v = statistics.median(bench_env(procs, envs, point_seconds, seed=r) for r in range(repeats))
        points.append({"procs": procs, "envsPerProc": envs, "value": round(v)})
        print(f"env procs={procs} envs/proc={envs}: {v:,.0f} env steps/s", flush=True)
        if n in e2e_after:
            e2e.append(bench_end_to_end(CPU_SLOTS, 64, device))
            cpu_samples.append(bench_update_ms("cpu", iters=20))
            if mps_samples:
                mps_samples.append(bench_update_ms("mps", iters=20))
            print(f"  end to end sample {len(e2e)}: {e2e[-1]:,.0f} steps/s (load {os.getloadavg()[0]:.1f})", flush=True)
    cpu_ms, mps_ms = statistics.median(cpu_samples), (statistics.median(mps_samples) if mps_samples else None)
    faster = "mps" if mps_ms is not None and mps_ms < cpu_ms else "cpu"
    final_device = force_device or faster
    update_ms = mps_ms if final_device == "mps" else cpu_ms
    best = max((p for p in points if p["procs"] <= CPU_SLOTS), key=lambda p: p["value"])
    batch_envs = best["procs"] * best["envsPerProc"]
    infer_ms = bench_infer_ms(2 * batch_envs)
    projected = project_ppo_steps_per_sec(best["value"], infer_ms, batch_envs, update_ms)
    R = statistics.median(e2e)
    R_min = min(e2e)
    print(
        f"projected PPO {projected:,.0f} steps/s; end to end min {R_min:,.0f}, median {R:,.0f}, max {max(e2e):,.0f}; "
        f"update cpu {cpu_ms:.1f} ms, mps {mps_ms if mps_ms is None else round(mps_ms, 1)} ms",
        flush=True,
    )
    return {
        "envStepsPerSec": points,
        "ppoUpdate": {"cpuMs": round(cpu_ms, 2), "mpsMs": None if mps_ms is None else round(mps_ms, 2),
            "fasterDeviceByMedians": faster,
            "device": final_device,
            "deviceReason": force_reason if force_device else "lower median update time",
            "endToEndDevice": device,
        },
        "projectedPpoStepsPerSec": round(projected),
        "measuredEndToEndStepsPerSec": {"min": round(R_min), "median": round(R), "max": round(max(e2e)), "samples": [round(x) for x in e2e]},
        "rateUsedForBudgets": round(R),
        "budgets": budgets(R),
        "budgetsAtMinRate": budgets(R_min),
        "meta": {
            "pointSeconds": point_seconds,
            "repeatsPerPoint": repeats,
            "pointValue": "median of repeats",
            "policy": f"MLP 2x{HIDDEN}, minibatch {MINIBATCH}, {EPOCHS} epochs, rollout {ROLLOUT_STEPS} steps, frame skip 4, learner and opponent nets on CPU",
            "budgetArithmetic": budget_arithmetic(R),
            "bestTwoSlotPoint": best,
            "inferenceMsPerRolloutStep": round(infer_ms, 3),
            "loadAverageAtEnd": [round(x, 2) for x in os.getloadavg()],
            "threshold": 8000,
            "caveat": "Measured while other lanes were running on the same 8 cores, so every figure is a loaded-machine figure. End to end excludes league bookkeeping, the HumanLimiter and logging.",
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--point-seconds", type=float, default=20.0)
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--device", choices=("cpu", "mps"), help="force the PPO update device (scheduling reason required)")
    ap.add_argument("--device-reason", help="why the device is forced")
    args = ap.parse_args()
    if bool(args.device) != bool(args.device_reason):
        ap.error("--device and --device-reason go together")
    result = run(args.point_seconds, args.repeats, force_device=args.device, force_reason=args.device_reason)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
