import json
from pathlib import Path

import numpy as np
import pytest
import torch

from trainer.chess import export as chess_export
from trainer.chess import selfplay_value as sp
from trainer.chess.data import SPARSE_FEATURES
from trainer.chess.value_net import ValueNet
from trainer.jobs import load_spec

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def weights(tmp_path_factory):
    torch.manual_seed(3)
    net = ValueNet(32, 8)
    d = tmp_path_factory.mktemp("w")
    chess_export.write_value_bin(net, d / "value.bin")
    return net, d / "value.bin"


@pytest.fixture(scope="module")
def games(weights):
    # Two self-play games through the bridge, capped at 24 plies so the test stays fast.
    return sp.play_games(weights[1], games=2, nodes=150, seed=11, max_plies=24, open_plies=2)


def test_two_selfplay_games_come_back_through_the_bridge(games):
    assert len(games) == 2
    for g in games:
        assert 1 <= len(g["moves"]) <= 24
        n = len(g["feats"])
        assert n == len(g["scores"]) == len(g["seats"]) == len(g["moves"]) - g["opening"] - g["forced"]
        assert n > 0
        for f, seat in zip(g["feats"], g["seats"]):
            assert 1 <= len(f) <= 32 and all(0 <= i < SPARSE_FEATURES for i in f)
            assert seat in (0, 1)
        assert g["winner"] in (0, 1, None)
        if g["truncated"]:
            assert g["winner"] is None


def test_same_seed_same_games(weights, games):
    again = sp.play_games(weights[1], games=2, nodes=150, seed=11, max_plies=24, open_plies=2)
    assert again == games


def test_targets_blend_outcome_and_search_score():
    game = {"moves": ["e2e4"] * 4, "opening": 0, "feats": [[0], [1], [2], [3]],
            "scores": [0, 100, -100, 20000], "seats": [0, 1, 0, 1], "winner": 0, "truncated": False}
    x, t = sp.build_targets([game], lam=0.5)
    assert x.shape == (4, SPARSE_FEATURES) and x[2, 2] == 1 and x[2].sum() == 1
    sig = lambda z: 1 / (1 + np.exp(-z))
    # mover wins at ply 0 (seat 0): outcome 1; seat 1 loses: outcome 0
    expect = [0.5 * 1 + 0.5 * sig(0), 0.5 * 0 + 0.5 * sig(1.0), 0.5 * 1 + 0.5 * sig(-1.0), 0.5 * 0 + 0.5 * sig(sp.SCORE_CLAMP)]
    assert t.tolist() == pytest.approx(expect, abs=1e-5)
    # a truncated game has no outcome: its targets are the search score alone
    game2 = dict(game, truncated=True, winner=None)
    _, t2 = sp.build_targets([game2], lam=0.5)
    assert t2.tolist() == pytest.approx([sig(0), sig(1.0), sig(-1.0), sig(sp.SCORE_CLAMP)], abs=1e-5)
    # draw: 0.5 for both seats
    _, t3 = sp.build_targets([dict(game, winner=None)], lam=1.0)
    assert t3.tolist() == pytest.approx([0.5] * 4)


def test_twenty_steps_lower_the_loss(weights, games):
    x, t = sp.build_targets(games, lam=0.5)
    net = ValueNet(32, 8)
    net.load_state_dict(weights[0].state_dict())
    losses = sp.finetune(net, x, t, steps=20, lr=5e-3, batch=len(t), seed=0)
    assert len(losses) == 20 and losses[-1] < losses[0]


def test_candidate_is_written_unpromoted_and_never_into_the_shipped_folder(weights, tmp_path):
    out = sp.write_candidate(weights[0], tmp_path / "candidates", version=3, meta={"games": 2})
    assert out.name == "v0003"
    meta = json.loads((out / "meta.json").read_text())
    assert meta["promoted"] is False and meta["games"] == 2 and meta["gate"] == "T50"
    w = chess_export.read_value_bin(out / "value.bin")
    assert w["h1"] == 32 and (out / "value.onnx").exists()
    assert "apps/web/public" not in str(out)


def test_job_spec_is_valid_and_follows_chess_value():
    spec = load_spec("chess-sp")
    assert spec.name == "chess-sp" and spec.after == ["chess-value"]
    assert spec.cpu_slots == 2 and spec.max_hours and spec.max_hours <= 6
    assert spec.cmd[:3] == ["scripts/py", "-m", "trainer.chess.selfplay_value"]


def test_bridge_death_while_stopping_is_a_stop_not_an_error():
    stop = {"flag": False}

    def dies(**_kw):
        stop["flag"] = True
        raise sp.BridgeError("bridge process exited with code -15")

    assert sp.play_with_retry(stop, play=dies, value_bin="x", games=1) is None


def test_bridge_death_is_retried_with_a_new_seed_then_raised():
    seeds = []

    def flaky(**kw):
        seeds.append(kw["seed"])
        if len(seeds) < 3:
            raise sp.BridgeError("boom")
        return ["ok"]

    assert sp.play_with_retry({"flag": False}, play=flaky, value_bin="x", games=1, seed=7) == ["ok"]
    assert len(set(seeds)) == 3

    def always(**_kw):
        raise sp.BridgeError("boom")

    with pytest.raises(sp.BridgeError):
        sp.play_with_retry({"flag": False}, max_restarts=1, play=always, value_bin="x", games=1)


def test_next_version_never_reuses_a_candidate_on_disk(tmp_path):
    assert sp.next_version(tmp_path / "none", 0) == 1
    for v in ("v0001", "v0004"):
        (tmp_path / v).mkdir()
    assert sp.next_version(tmp_path, 2) == 5
    assert sp.next_version(tmp_path, 9) == 10


def test_resume_restores_adam_state(weights, tmp_path):
    from trainer.checkpoint import save_checkpoint

    model = ValueNet(32, 8)
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    x = torch.rand(16, SPARSE_FEATURES)
    sp.finetune(model, x, torch.rand(16), steps=3, lr=1e-3, batch=16, opt=opt)
    save_checkpoint(tmp_path, 3, model, opt, keep_last=3, extra={"iter": 3, "arch": model.arch()})
    _, opt2, extra = sp._start_model(tmp_path, tmp_path, True, 1e-3)
    assert extra["iter"] == 3
    assert len(opt2.state) > 0 and all("exp_avg" in st for st in opt2.state.values())
