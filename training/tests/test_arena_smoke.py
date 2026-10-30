"""Arena env, bots and trainer wiring (T10). The slow test is the 15 minute smoke from the plan."""

import json
import time

import numpy as np
import pytest
import torch

from trainer.bridge import BridgeEnv
from trainer.checkpoint import load_latest
from trainer.ppo import bc
from trainer.ppo import eval_bots as E
from trainer.ppo import league as L
from trainer.ppo import train_realtime as T
from trainer.ppo.ppo import Agent

NVEC = T.GAMES["arena"].nvec


def _obs_size() -> int:
    with BridgeEnv("arena", 1, seed=1) as env:
        return int(env.obs_shape[-1])


def _tiny(tmp_path, **kw):
    paths = T.RunPaths(tmp_path / "ckpt", tmp_path / "league", [], tmp_path)
    return T.Trainer("arena", T.make_stage("A", None, None), paths, procs=2, envs_per_proc=8, seed=3, snapshot_every=2048,
                     log=kw.pop("log", lambda *_: None), **kw)


def test_the_arena_env_speaks_the_bridge_with_nine_action_heads():
    with BridgeEnv("arena", 3, seed=5) as env:
        assert env.action_dims == len(NVEC) == 9
        obs = env.reset()
        assert obs.shape == (3, 2, _obs_size()) and np.isfinite(obs).all()
        act = np.zeros((3, 2, 9), np.int32)
        act[..., 6], act[..., 7] = 4, 3  # zero turn
        o, r, d, _ = env.step(act)
        assert o.shape == obs.shape and r.shape == (3,) and d.shape == (3,)


def test_bot_actions_carry_the_sentinel_in_the_first_head_for_each_game():
    assert L.bot_action("random") == [-1, 0]
    assert L.bot_action("turtle") == [-3, 0]
    assert L.bot_action("random", 9, "arena") == [-1] + [0] * 8
    assert L.bot_action("holder", 9, "arena") == [-3] + [0] * 8
    assert L.League(bots=L.BOTS["arena"]).entries()[1].name == "rusher"


def test_an_arena_stage_trains_checkpoints_and_resumes(tmp_path):
    tr = _tiny(tmp_path)
    step = tr.run(4096)
    assert step >= 4096
    info = load_latest(tmp_path / "ckpt")
    assert info["extra"]["game"] == "arena" and info["extra"]["nvec"] == list(NVEC)
    assert list((tmp_path / "league").glob("snap-A-*.pt"))
    assert {e.name for e in tr.league.entries()} >= {"random", "rusher", "holder"}
    assert _tiny(tmp_path).run(step + 2048, resume=True) >= step + 2048


def test_the_close_range_curriculum_runs_first_then_the_normal_start(tmp_path):
    lines: list[str] = []
    levels: list[str] = []
    tr = _tiny(tmp_path, close_steps=2048, log=lines.append)
    orig = T.BridgeEnv

    def spy(game, n, seed=0, level=None):
        levels.append(level)
        return orig(game, n, seed=seed, level=level)

    T.BridgeEnv = spy
    try:
        step = tr.run(4096)
    finally:
        T.BridgeEnv = orig
    assert step >= 4096
    assert any("close-range curriculum done" in str(x) for x in lines)
    assert levels[0] == "champion@close" and levels[-1] == "champion"
    assert {"champion@close", "champion"} <= set(levels)
    # A resumed run past the curriculum goes straight to the normal start.
    levels.clear()
    T.BridgeEnv = spy
    try:
        _tiny(tmp_path, close_steps=2048).run(step + 2048, resume=True)
    finally:
        T.BridgeEnv = orig
    assert set(levels) == {"champion"}


def test_budgets_scale_for_a_slower_env():
    b = {"morning": {"stageA": 1000, "hard": 100}, "full": {"stageA": 5000, "hard": 500}}
    assert T.scaled_budgets(b, 0.5) == {"morning": {"stageA": 500, "hard": 50}, "full": {"stageA": 2500, "hard": 250}}


def test_eval_counts_rounds_for_the_arena(tmp_path):
    torch.manual_seed(1)
    r = E.evaluate(Agent(_obs_size(), NVEC), "random", 0, game="arena", rounds=30, n_envs=4)
    assert r["roundsPlayed"] >= 30 and r["games"] >= 1
    assert 0 <= r["roundCi95"][0] <= r["roundWinRate"] <= r["roundCi95"][1] <= 1


def test_eval_can_pin_the_learner_to_one_seat_and_reports_each_seat():
    """The page seats the AI on one seat, so the gate must measure that seat (judge coldstore-r2 fix 1)."""
    torch.manual_seed(1)
    both = E.evaluate(Agent(_obs_size(), NVEC), "random", 8, game="arena", n_envs=4)
    assert set(both["bySeat"]) == {"0", "1"} and both["bySeat"]["0"]["games"] + both["bySeat"]["1"]["games"] == both["games"]
    for seat in (0, 1):
        r = E.evaluate(Agent(_obs_size(), NVEC), "random", 8, game="arena", n_envs=4, seat=seat)
        assert r["seat"] == seat and r["bySeat"][str(1 - seat)]["games"] == 0 and r["bySeat"][str(seat)]["games"] == r["games"] >= 8


def test_the_behaviour_cloning_warm_start_copies_the_bots():
    obs, act = bc.collect(6000, teachers="rusher")
    assert obs.shape == (6000, _obs_size()) and act.shape == (6000, 9) and (act < np.array(NVEC)).all()
    torch.manual_seed(0)
    agent = Agent(obs.shape[1], NVEC)
    with torch.no_grad():
        first = float(sum(torch.nn.functional.cross_entropy(l, torch.from_numpy(act[:, i]))
                          for i, l in enumerate(torch.split(agent.actor(agent.trunk(torch.from_numpy(obs))), list(NVEC), dim=-1))) / 9)
    last = bc.fit(agent, obs, act, epochs=4)
    assert last < 0.6 * first


def test_a_trainer_with_a_warm_start_logs_it_and_still_trains(tmp_path):
    lines: list[str] = []
    tr = _tiny(tmp_path, warm_start=4000, log=lines.append)
    assert tr.run(2048) >= 2048
    assert any("behaviour-cloning warm start done" in str(x) for x in lines)


@pytest.mark.slow
def test_smoke_the_learner_beats_the_random_bot_in_200_rounds(tmp_path):
    """15 minutes on 2 slots: a behaviour-cloning warm start from the rusher bot, then stage A with the close-range curriculum, then whole matches against the random bot until 200 rounds are played."""
    tr = T.Trainer("arena", T.make_stage("A", None, None), T.RunPaths(tmp_path / "ckpt", tmp_path / "league", [], tmp_path),
                   procs=2, envs_per_proc=64, seed=11, snapshot_every=1_000_000, log=print, close_steps=1_500_000, warm_start=300_000)
    t0 = time.time()
    step = tr.run(10**9, max_seconds=13 * 60)
    train_s = time.time() - t0
    res = E.evaluate(tr.agent, "random", 0, game="arena", rounds=200)
    out = {"trainSeconds": round(train_s), "steps": step, **res}
    print("SMOKE", json.dumps(out))
    (tmp_path / "smoke.json").write_text(json.dumps(out))
    assert res["roundsPlayed"] >= 200
    assert res["roundWinRate"] >= 0.80
