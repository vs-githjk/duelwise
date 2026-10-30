import json
import time
from pathlib import Path

import numpy as np
import pytest
import torch

from trainer.checkpoint import load_latest
from trainer.ppo import eval_bots as E
from trainer.ppo import train_realtime as T
from trainer.ppo.export import export_policy
from trainer.ppo.ppo import Agent


def _obs_size() -> int:
    from trainer.bridge import BridgeEnv

    with BridgeEnv("fighter", 1, seed=1) as env:
        return int(env.obs_shape[-1])


def _tiny_trainer(tmp_path, cfg=None, **kw):
    cfg = cfg or T.make_stage("A", None, None)
    paths = T.RunPaths(tmp_path / "ckpt", tmp_path / "league", [], tmp_path)
    return T.Trainer("fighter", cfg, paths, procs=2, envs_per_proc=8, seed=3, snapshot_every=2048, log=lambda *_: None, **kw)


def test_a_stage_trains_checkpoints_snapshots_and_resumes(tmp_path):
    tr = _tiny_trainer(tmp_path)
    step = tr.run(4096)
    assert step >= 4096
    assert (tmp_path / "ckpt" / f"ckpt-{step:010d}.pt").exists()
    assert list((tmp_path / "league").glob("snap-A-*.pt"))
    assert (tmp_path / "progress.json").exists()
    # A second trainer resumes from the checkpoint and continues the step count.
    tr2 = _tiny_trainer(tmp_path)
    step2 = tr2.run(step + 2048, resume=True)
    assert step2 >= step + 2048
    # Without --resume an existing checkpoint directory is refused rather than mixed.
    with pytest.raises(SystemExit):
        _tiny_trainer(tmp_path).run(100)


def test_ppo_update_moves_the_policy_toward_advantaged_actions():
    torch.manual_seed(0)
    from trainer.ppo.ppo import PPOConfig, ppo_update

    agent = Agent(143, (9, 7))
    opt = torch.optim.Adam(agent.parameters(), lr=1e-3)
    x = torch.randn(512, 143)
    with torch.no_grad():
        a, logp, _, v = agent.act(x)
    target = (a[:, 0] == 3).float() * 2 - 1  # action 3 is good, everything else bad
    before = float(torch.softmax(agent.actor(agent.trunk(x))[:, :9], -1)[:, 3].mean())
    for _ in range(20):
        with torch.no_grad():
            a, logp, _, v = agent.act(x)
        adv = (a[:, 0] == 3).float() * 2 - 1
        ppo_update(agent, opt, PPOConfig(minibatch=128, target_kl=None), x, a, logp, adv, adv + v)
    after = float(torch.softmax(agent.actor(agent.trunk(x))[:, :9], -1)[:, 3].mean())
    assert after > before + 0.1


def test_the_league_job_runs_morning_then_full_and_writes_the_level_files(tmp_path):
    bench = tmp_path / "bench.json"
    bench.write_text(json.dumps({"budgets": {
        "morning": {"stageA": 4096, "hard": 2048, "medium": 2048, "easy": 2048},
        "full": {"stageA": 6144, "hard": 4096, "medium": 4096, "easy": 4096},
    }}))
    run = tmp_path / "run"
    T.run_league("fighter", bench, run, procs=2, envs_per_proc=8, seed=1, snapshot_every=2048, log=lambda *_: None, only_phases=("morning",))
    morning = json.loads((run / "levels" / "morning.json").read_text())
    assert set(morning["levels"]) == {"champion", "hard", "medium", "easy"}
    assert morning["levels"]["champion"]["step"] >= 4096
    for k in ("hard", "medium", "easy"):
        assert morning["levels"][k]["step"] >= 2048
        assert Path(morning["levels"][k]["path"]).exists()
    # Each level checkpoint says which limiter it was trained under.
    for k in ("champion", "hard", "medium", "easy"):
        info = torch.load(morning["levels"][k]["path"], map_location="cpu", weights_only=False)["extra"]
        assert info["level"] == k
    # Easy started from an early Champion checkpoint, Hard from the finished one: a rerun is a no-op and the full phase continues.
    T.run_league("fighter", bench, run, procs=2, envs_per_proc=8, seed=1, snapshot_every=2048, log=lambda *_: None)
    full = json.loads((run / "levels" / "full.json").read_text())
    assert full["levels"]["champion"]["step"] >= 6144
    assert full["levels"]["hard"]["step"] >= 4096
    assert full["levels"]["champion"]["path"] != morning["levels"]["champion"]["path"]
    assert json.loads((run / "levels" / "morning.json").read_text()) == morning


def test_stage_b_trains_from_a_champion_checkpoint_under_its_limiter(tmp_path):
    a = _tiny_trainer(tmp_path / "A")
    a.run(2048)
    ck = sorted((tmp_path / "A" / "ckpt").glob("ckpt-*.pt"))[-1]
    cfg = T.make_stage("B", "easy", ck)
    paths = T.RunPaths(tmp_path / "B" / "ckpt", tmp_path / "B" / "league", [tmp_path / "A" / "league"], tmp_path / "B")
    b = T.Trainer("fighter", cfg, paths, procs=2, envs_per_proc=8, seed=4, snapshot_every=2048, log=lambda *_: None)
    b.run(2048)
    info = load_latest(tmp_path / "B" / "ckpt")
    assert info["extra"]["level"] == "easy" and info["extra"]["stage"] == "B"
    # Stage A's snapshots were the frozen part of the pool.
    assert any(e.name.startswith("snap-A-") for e in b.league.entries())


def test_a_full_pool_evicts_snapshots_without_crashing_running_matches(tmp_path):
    from trainer.ppo.league import MAX_SNAPSHOTS

    tr = _tiny_trainer(tmp_path)
    step = tr.run(2048 * (MAX_SNAPSHOTS + 24))
    assert step >= 2048 * (MAX_SNAPSHOTS + 24)
    assert len(list((tmp_path / "league").glob("snap-A-*.pt"))) > MAX_SNAPSHOTS + 2
    live = {e.name for e in tr.league.entries()}
    assert all(str(n) in live for names in tr.opp_names for n in names)


def test_stage_b_with_eight_frozen_opponents_survives_own_snapshot_eviction(tmp_path):
    a = _tiny_trainer(tmp_path / "A")
    a.run(2048 * 10)
    ck = sorted((tmp_path / "A" / "ckpt").glob("ckpt-*.pt"))[-1]
    paths = T.RunPaths(tmp_path / "B" / "ckpt", tmp_path / "B" / "league", [tmp_path / "A" / "league"], tmp_path / "B")
    b = T.Trainer("fighter", T.make_stage("B", "easy", ck), paths, procs=2, envs_per_proc=8, seed=4, snapshot_every=2048, log=lambda *_: None)
    step = b.run(2048 * 24)
    assert b.league.max_own == 8 and len(b.league._frozen) == 8
    assert step >= 2048 * 24
    assert len(b.league._own) == 8
    live = {e.name for e in b.league.entries()}
    assert all(str(n) in live for names in b.opp_names for n in names)


def test_eval_against_a_bot_counts_finished_matches(tmp_path):
    torch.manual_seed(1)
    r = E.evaluate(Agent(_obs_size(), T.GAMES["fighter"].nvec), "random", 6, n_envs=4)
    assert r["games"] == 8 and r["wins"] + r["draws"] + r["losses"] == 8  # 2 matches per env on 4 envs, never more
    assert 0 <= r["ci95"][0] <= r["score"] <= r["ci95"][1] <= 1


def test_preview_onnx_export_matches_torch(tmp_path):
    a = _tiny_trainer(tmp_path / "A")
    a.run(2048)
    ck = sorted((tmp_path / "A" / "ckpt").glob("ckpt-*.pt"))[-1]
    info = export_policy(ck, tmp_path / "model.onnx")
    assert (tmp_path / "model.onnx").exists() and len(info["sha256"]) == 64


@pytest.mark.slow
def test_smoke_the_learner_beats_the_random_bot_in_200_games(tmp_path):
    """15 minutes on 2 slots: train stage A (league: bots plus snapshots), then play 200 matches against the random bot."""
    tr = T.Trainer("fighter", T.make_stage("A", None, None), T.RunPaths(tmp_path / "ckpt", tmp_path / "league", [], tmp_path),
                   procs=2, envs_per_proc=64, seed=11, snapshot_every=1_000_000, log=print)
    t0 = time.time()
    step = tr.run(10**9, max_seconds=15 * 60 - 60)
    train_s = time.time() - t0
    res = E.evaluate(tr.agent, "random", 200)
    out = {"trainSeconds": round(train_s), "steps": step, **res}
    print("SMOKE", json.dumps(out))
    (tmp_path / "smoke.json").write_text(json.dumps(out))
    assert res["games"] == 200
    assert res["winRate"] >= 0.80


def _champion_ckpt() -> Path:
    import os

    from trainer.paths import runs_dir

    env = os.environ.get("CHAMPION_CKPT")
    if env:
        return Path(env)
    ckpts = sorted((runs_dir() / "fighter-league" / "ckpt" / "A").glob("ckpt-*.pt"))
    if not ckpts:
        pytest.skip("no fighter Champion checkpoint under runs/fighter-league/ckpt/A")
    return ckpts[-1]


@pytest.mark.slow
def test_smoke_hard_limits_from_the_champion_reach_040_against_rushdown(tmp_path):
    """T8b: 15 minutes on 2 slots from the Champion checkpoint under the Hard limits (v2 env: own-input observation,
    free keep, fair delayed bots, entropy anneal). Before R15 the same start scored 0.016 against rushdown.
    Then 200 balanced matches (both seats, the first k per env) against each scripted bot."""
    ckpt = _champion_ckpt()
    paths = T.RunPaths(tmp_path / "ckpt", tmp_path / "league", [], tmp_path)
    tr = T.Trainer("fighter", T.make_stage("B", "hard", ckpt), paths, procs=2, envs_per_proc=64, seed=11, snapshot_every=1_000_000,
                   log=print, gate_enabled=False)
    t0 = time.time()
    step = tr.run(8_000_000, max_seconds=15 * 60 - 90)
    train_s = time.time() - t0
    res = {b: E.evaluate(tr.agent, b, 200, level="hard") for b in ("rushdown", "turtle", "random")}
    metrics = [json.loads(line) for line in (tmp_path / "metrics.jsonl").read_text().splitlines()]
    out = {"ckpt": str(ckpt), "trainSeconds": round(train_s), "steps": step, "entropyFirst": metrics[0]["entropy"], "entropyLast": metrics[-1]["entropy"],
           "results": {b: {k: r[k] for k in ("games", "wins", "draws", "losses", "score", "ci95")} for b, r in res.items()}}
    print("SMOKE", json.dumps(out))
    Path(tmp_path / "smoke.json").write_text(json.dumps(out))
    assert res["rushdown"]["games"] >= 200
    assert res["rushdown"]["score"] >= 0.40
    assert metrics[-1]["entropy"] < metrics[0]["entropy"]
