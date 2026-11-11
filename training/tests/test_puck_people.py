"""Air hockey people bots in the training pool (A3): names, sentinels, and a live rollout through the bridge."""

import numpy as np
import pytest

from trainer import bridge as B
from trainer.ppo import league as L
from trainer.ppo import train_realtime as T


def test_people_bot_names_and_sentinels():
    assert L.people_bots(("average",)) == tuple(f"{k}@average" for k in L.PEOPLE_BOT_KINDS)
    assert L.bot_action("mouse@beginner", 2, "puck") == [-1 - 16, 0]
    assert L.bot_action("shadow@strong", 2, "puck") == [-1 - (16 * 3 + 4), 0]
    # plain bots are untouched
    assert L.bot_action("striker", 2, "puck") == [-2, 0]
    with pytest.raises(ValueError):
        L.people_bots(("expert",))


def test_default_pool_has_no_people_bots_and_the_flag_adds_them(tmp_path):
    paths = T.RunPaths(tmp_path / "ckpt", tmp_path / "league", [], tmp_path)
    kw = dict(procs=1, envs_per_proc=2, seed=1, log=lambda *a: None)
    plain = T.Trainer("puck", T.make_stage("A", None, None), paths, **kw)
    plain.agent = None
    assert plain.people_profiles == ()
    withp = T.Trainer("puck", T.make_stage("A", None, None), paths, people_bots=("average", "strong"), **kw)
    assert withp.people_profiles == ("average", "strong")
    assert len(L.people_bots(withp.people_profiles)) == 10


def test_a_people_sentinel_plays_a_rollout_through_the_bridge():
    with B.BridgeEnv("puck", 2, seed=3, level="medium") as env:
        env.reset([5, 6])
        act = np.zeros((2, 2, len(env.nvec) if hasattr(env, "nvec") else 2), np.int32)
        act[:, 0] = [5, 5]
        for name in ("mouse@average", "striker@strong"):
            act[:, 1] = L.bot_action(name, act.shape[-1], "puck")
            for _ in range(30):
                env.step(act)
