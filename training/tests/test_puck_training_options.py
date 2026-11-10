"""Air hockey stage A training options: self-play floor, training-only Champion bot delay, goal shaping.

The gate (Champion bots see the live game) must never receive the training options.
"""

import numpy as np

from trainer import bridge as B
from trainer.ppo import eval_bots as E
from trainer.ppo import gate as G
from trainer.ppo import train_realtime as T


def _trainer(tmp_path, **kw):
    paths = T.RunPaths(tmp_path / "ckpt", tmp_path / "league", [], tmp_path)
    return T.Trainer("puck", T.make_stage("A", None, None), paths, procs=1, envs_per_proc=2, seed=1, gate_every=1, gate_games=2,
                     gate_stage_a=True, log=lambda *a: None, **kw)


def _spy(monkeypatch, module):
    calls = []
    real = module.BridgeEnv

    def make(*args, **kwargs):
        calls.append(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(module, "BridgeEnv", make)
    return calls


def test_the_bridge_passes_the_training_options_as_flags_and_omits_them_by_default():
    with B.BridgeEnv("puck", 1, seed=1, level="champion") as plain:
        assert "--champion-bot-delay" not in plain.cmd and "--goal-shaping" not in plain.cmd
    with B.BridgeEnv("puck", 1, seed=1, level="champion", champion_bot_delay=9, goal_shaping=0.002) as env:
        assert env.cmd[env.cmd.index("--champion-bot-delay") + 1] == "9"
        assert env.cmd[env.cmd.index("--goal-shaping") + 1] == "0.002"


def test_training_envs_get_delay_9_and_the_gate_envs_stay_live(tmp_path, monkeypatch):
    train_calls = _spy(monkeypatch, T)
    gate_calls = _spy(monkeypatch, E)
    tr = _trainer(tmp_path, train_champion_bot_delay=9, goal_shaping=0.002)
    env = tr._make_env(0)
    env.close()
    assert train_calls[-1]["champion_bot_delay"] == 9 and train_calls[-1]["goal_shaping"] == 0.002
    with B.BridgeEnv("puck", 1, seed=1, level="champion") as probe:
        obs_size = int(probe.obs_shape[-1])
    tr.agent = T.build_agent(tr.cfg, obs_size, tr.spec.nvec)
    state = {k: v.detach().clone() for k, v in tr.agent.state_dict().items()}
    tr._run_gate(state)
    assert gate_calls, "the gate built no env"
    for kw in gate_calls:
        assert not kw.get("champion_bot_delay") and not kw.get("goal_shaping")
        assert kw["level"] == "champion"


def test_defaults_leave_training_envs_unchanged(tmp_path, monkeypatch):
    calls = _spy(monkeypatch, T)
    tr = _trainer(tmp_path)
    tr._make_env(0).close()
    assert not calls[-1].get("champion_bot_delay") and not calls[-1].get("goal_shaping")


def test_self_play_floor_sends_that_fraction_of_games_to_own_snapshots(tmp_path):
    tr = _trainer(tmp_path, self_play_floor=0.5)
    state = {"w": 1}
    from trainer.ppo import league as L

    tr.league = L.League(rng=np.random.default_rng(0), bots=L.TRAINING_BOTS["puck"])
    for s in (1, 2, 3):
        tr.league.add_snapshot(f"snap-A-{s:010d}", state, s)
    names = [tr._pick() for _ in range(4000)]
    frac = sum(n.startswith("snap-") for n in names) / len(names)
    assert 0.5 <= frac <= 0.75  # the floor plus whatever PFSP already sends to snapshots


def test_self_play_floor_zero_is_plain_pfsp_and_no_snapshots_falls_back_to_bots(tmp_path):
    from trainer.ppo import league as L

    tr = _trainer(tmp_path, self_play_floor=0.5)
    tr.league = L.League(rng=np.random.default_rng(0), bots=L.TRAINING_BOTS["puck"])
    assert all(not tr._pick().startswith("snap-") for _ in range(200))  # no snapshots yet
    tr2 = _trainer(tmp_path)
    tr2.league = L.League(rng=np.random.default_rng(0), bots=L.TRAINING_BOTS["puck"])
    for s in (1, 2):
        tr2.league.add_snapshot(f"snap-A-{s:010d}", {"w": 1}, s)
    ref = L.League(rng=np.random.default_rng(0), bots=L.TRAINING_BOTS["puck"])
    for s in (1, 2):
        ref.add_snapshot(f"snap-A-{s:010d}", {"w": 1}, s)
    assert [tr2._pick() for _ in range(50)] == [ref.sample().name for _ in range(50)]
