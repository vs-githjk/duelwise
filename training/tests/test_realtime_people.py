"""Tinderbox and Coldstore people bots in the training pool (A4): names, sentinels, and a live rollout through the bridge."""

import numpy as np
import pytest

from trainer import bridge as B
from trainer.ppo import league as L
from trainer.ppo import train_realtime as T


def test_people_bot_names_and_sentinels_for_fighter_and_arena():
    assert L.people_bots(("average",), "fighter") == tuple(f"{k}@average" for k in ("rushdown", "turtle", "zoner", "fireball"))
    assert L.people_bots(("beginner",), "arena") == tuple(f"{k}@beginner" for k in ("rusher", "holder", "peeker", "strafe", "holdangle"))
    # the kind part is the bot's index in the env's own bot order (FIGHTER_BOT_KINDS, ARENA_BOT_KINDS)
    assert L.bot_action("rushdown@beginner", 2, "fighter") == [-1 - (16 + 1), 0]
    assert L.bot_action("fireball@strong", 2, "fighter") == [-1 - (16 * 3 + 8), 0]
    assert L.bot_action("peeker@average", 9, "arena") == [-1 - (16 * 2 + 3)] + [0] * 8
    # plain bots and the puck's people bots are untouched
    assert L.bot_action("zoner", 2, "fighter") == [-4, 0]
    assert L.bot_action("mouse@beginner", 2, "puck") == [-1 - 16, 0]
    with pytest.raises(ValueError):
        L.people_bots(("expert",), "fighter")


def test_people_kinds_are_real_bots_of_their_game():
    for game in ("fighter", "arena"):
        assert all(k in L.BOTS[game] for k in L.PEOPLE_KINDS[game])
        assert len(L.BOTS[game]) < 16


def test_the_flag_adds_the_game_s_people_bots_to_the_pool(tmp_path):
    paths = T.RunPaths(tmp_path / "ckpt", tmp_path / "league", [], tmp_path)
    kw = dict(procs=1, envs_per_proc=2, seed=1, log=lambda *a: None)
    for game, n in (("fighter", 8), ("arena", 10)):
        t = T.Trainer(game, T.make_stage("A", None, None), paths, people_bots=("average", "strong"), **kw)
        assert len(L.people_bots(t.people_profiles, game)) == n


@pytest.mark.parametrize("game,level,names", [("fighter", "hard", ("rushdown@average", "fireball@strong")), ("arena", "hard", ("rusher@beginner", "holdangle@strong"))])
def test_a_people_sentinel_plays_a_rollout_through_the_bridge(game, level, names):
    with B.BridgeEnv(game, 2, seed=3, level=level) as env:
        env.reset([5, 6])
        dims = 2 if game == "fighter" else 9
        act = np.zeros((2, 2, dims), np.int32)
        for name in names:
            act[:, 1] = L.bot_action(name, dims, game)
            for _ in range(40):
                env.step(act)
