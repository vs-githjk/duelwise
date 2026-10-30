import numpy as np
import pytest

from trainer.bridge import BridgeError, SelfPlayDriver, find_bun, _main_ts


def cmd(n, games, sims, extra=()):
    return [find_bun(), str(_main_ts()), "--game", "four", "--mode", "selfplay", "--n", str(n),
            "--games", str(games), "--sims", str(sims), "--seed", "7", *extra]


def uniform(calls):
    def fn(batch):
        calls.append(batch.shape)
        n = batch.shape[0]
        return np.zeros((n, 7), dtype=np.float32), np.zeros(n, dtype=np.float32)

    return fn


def test_selfplay_mode_answers_four_eval_requests_and_ends_with_games():
    # One game, 3 simulations: the root and each simulation ask once, then max-plies 1 cuts the game.
    calls = []
    games = SelfPlayDriver("four", 1, 3, uniform(calls), cmd=cmd(1, 1, 3, ["--max-plies", "1"])).run()
    assert len(calls) == 4
    assert all(c == (1, 126) for c in calls)
    assert len(games) == 1
    g = games[0]
    assert g["truncated"] is True and g["winner"] is None
    assert len(g["moves"]) == 1 and len(g["visits"]) == 1
    assert sum(g["visits"][0]) == 3


def test_full_games_are_batched_legal_and_complete():
    calls = []
    games = SelfPlayDriver("four", 4, 8, uniform(calls), cmd=cmd(4, 6, 8)).run()
    assert len(games) == 6
    assert max(c[0] for c in calls) == 4 and max(c[0] for c in calls) > 1  # leaves of different games share a batch
    for g in games:
        assert g["truncated"] is False
        assert len(g["moves"]) == len(g["visits"]) == len(g["q"])
        heights = [0] * 7
        for m in g["moves"]:
            assert 0 <= m < 7 and heights[m] < 6
            heights[m] += 1
        assert g["winner"] in (0, 1, None)
        if g["winner"] is None:
            assert len(g["moves"]) == 42
        for v, m in zip(g["visits"], g["moves"]):
            assert sum(v) == 8 and v[m] > 0


def test_same_seed_same_games():
    a = SelfPlayDriver("four", 2, 6, uniform([]), cmd=cmd(2, 3, 6)).run()
    b = SelfPlayDriver("four", 2, 6, uniform([]), cmd=cmd(2, 3, 6)).run()
    assert a == b


def test_bad_game_is_an_error_not_a_hang():
    bad = [find_bun(), str(_main_ts()), "--game", "word", "--mode", "selfplay", "--n", "1"]
    with pytest.raises(BridgeError):
        SelfPlayDriver("word", 1, 1, uniform([]), cmd=bad).run()
