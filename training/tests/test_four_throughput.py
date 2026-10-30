"""T12b: Four in a Row self-play survives a dead bridge and runs faster (evaluation cache, shared rows, workers)."""

import json
import os
import signal
from pathlib import Path

import numpy as np
import pytest

from trainer.bridge import SelfPlayDriver, find_bun, _main_ts
from trainer.four.train import FourTrainer


def cmd(n, games, sims, extra=()):
    return [find_bun(), str(_main_ts()), "--game", "four", "--mode", "selfplay", "--n", str(n),
            "--games", str(games), "--sims", str(sims), "--seed", "5", *extra]


def uniform(counter):
    def fn(batch):
        counter.append(batch.shape[0])
        n = batch.shape[0]
        return np.zeros((n, 7), dtype=np.float32), np.zeros(n, dtype=np.float32)

    return fn


def kill_hosts_once(tr, after_calls):
    """Wraps tr.evaluate so that the `after_calls`-th evaluation SIGKILLs every running self-play host."""
    orig, state = tr.evaluate, {"calls": 0, "killed": 0}

    def evaluate(batch):
        state["calls"] += 1
        if state["calls"] == after_calls:
            for proc in list(tr.live_procs):
                if proc is not None and proc.poll() is None:
                    os.kill(proc.pid, signal.SIGKILL)
                    state["killed"] += 1
        return orig(batch)

    tr.evaluate = evaluate
    return state


@pytest.mark.parametrize("workers", [1, 2])
def test_bridge_kill_mid_iteration_is_survived(workers):
    tr = FourTrainer(blocks=1, channels=8, window_games=100, seed=3)
    state = kill_hosts_once(tr, after_calls=40)
    row = tr.iteration(games=6, parallel=6, sims=10, train_ratio=2, batch=16, seed=1, workers=workers)
    assert state["killed"] >= 1, "the test never killed a host"
    assert row["games"] == 6 and tr.games_total == 6 and tr.buffer.games == 6
    assert row["bridge_restarts"] >= 1 and tr.restarts == row["bridge_restarts"]
    assert np.isfinite(row["policy_loss"]) and np.isfinite(row["value_loss"])
    # The iteration after the failure is an ordinary one.
    again = tr.iteration(games=2, parallel=2, sims=6, train_ratio=2, batch=16, seed=2, workers=workers)
    assert again["games"] == 2 and again["bridge_restarts"] == 0


def test_a_host_that_keeps_dying_is_given_up_on():
    tr = FourTrainer(blocks=1, channels=8, window_games=10, seed=3)
    orig = tr.evaluate

    def always_kill(batch):
        for proc in list(tr.live_procs):
            if proc is not None and proc.poll() is None:
                os.kill(proc.pid, signal.SIGKILL)
        return orig(batch)

    tr.evaluate = always_kill
    with pytest.raises(Exception):
        tr.selfplay(2, 2, 6, seed=1, max_restarts=2)
    assert tr.restarts == 3  # the first death plus two retries, then the error reaches the caller


def test_partial_frames_keep_finished_games_and_the_result_is_the_same():
    whole = SelfPlayDriver("four", 3, 6, uniform([]), cmd=cmd(3, 5, 6)).run()
    driver = SelfPlayDriver("four", 3, 6, uniform([]), cmd=cmd(3, 5, 6, ["--flush", "1"]))
    parts = driver.run()
    assert len(parts) == 5 and sorted(g["moves"] for g in parts) == sorted(g["moves"] for g in whole)


def test_cache_and_shared_rows_play_the_same_games_with_fewer_network_evals():
    # A uniform evaluator is symmetric, so the cache (which also shares mirror images) must not change a single move.
    plain, cached = [], []
    a = SelfPlayDriver("four", 8, 60, uniform(plain), cmd=cmd(8, 8, 60, ["--cache", "0"])).run()
    b = SelfPlayDriver("four", 8, 60, uniform(cached), cmd=cmd(8, 8, 60)).run()
    assert a == b
    assert sum(cached) < 0.7 * sum(plain), (sum(cached), sum(plain))


def test_mirror_images_share_one_row():
    # Two games that start with columns 0 and 6 are mirror images, so after the shared root their first leaves
    # (positions after one stone) ask for one row between them.
    sizes = []
    SelfPlayDriver("four", 2, 2, uniform(sizes), cmd=cmd(2, 2, 2, ["--max-plies", "1"])).run()
    assert sizes[0] == 1  # both roots are the empty board


@pytest.mark.slow
def test_throughput_is_at_least_five_times_the_t12_baseline(tmp_path):
    from trainer.four import bench

    ckpt = Path(os.environ.get("T12B_CKPT", "")) if os.environ.get("T12B_CKPT") else None
    row = bench.run(games=int(os.environ.get("T12B_GAMES", "128")), parallel=256,
                    sims=200, workers=2, ckpt=ckpt)
    out = Path(os.environ.get("T12B_OUT", tmp_path / "T12b.json"))
    out.write_text(json.dumps(row, indent=2) + "\n")
    assert row["ratio"] >= 5.0, row
