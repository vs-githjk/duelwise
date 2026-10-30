import numpy as np
import pytest

from trainer import bench
from trainer.bridge import BridgeEnv


def test_budgets_morning_fits_100_minutes_and_splits_50_16():
    b = bench.budgets(R=3000.0)
    m = b["morning"]
    total = m["stageA"] + m["hard"] + m["medium"] + m["easy"]
    assert total <= 100 * 60 * 3000.0
    assert m["stageA"] == pytest.approx(0.5 * 100 * 60 * 3000.0, rel=1e-3)
    for k in ("hard", "medium", "easy"):
        assert m[k] == pytest.approx(0.5 / 3 * 100 * 60 * 3000.0, rel=1e-2)


def test_budgets_full_scales_the_plan_split_to_10_hours_at_r():
    for R in (1000.0, 10000.0):
        full = bench.budgets(R)["full"]
        cap = 10 * 3600 * R
        assert sum(full.values()) <= cap
        assert sum(full.values()) == pytest.approx(cap, rel=1e-3)
        assert full["stageA"] / full["hard"] == pytest.approx(60 / 25, rel=1e-2)
        assert full["easy"] / full["hard"] == pytest.approx(10 / 25, rel=1e-2)


@pytest.mark.parametrize("R", [500.0, 3000.0, 10000.0, 54000.0, 120000.0])
def test_budgets_full_is_never_below_morning(R):
    b = bench.budgets(R)
    for k in ("stageA", "hard", "medium", "easy"):
        assert b["full"][k] >= b["morning"][k]


def test_projection_is_below_the_raw_env_rate():
    r = bench.project_ppo_steps_per_sec(env_steps_per_sec=20000.0, infer_ms_per_batch=2.0, batch_envs=128, update_ms_per_minibatch=40.0)
    assert 0 < r < 20000.0


def test_fighter_env_runs_over_the_bridge():
    with BridgeEnv("fighter", 4, seed=1) as env:
        assert env.obs_shape == (2, bench.OBS_FEATURES_EXPECTED)
        assert env.action_dims == 2
        obs = env.reset()
        assert obs.shape == (4, 2, bench.OBS_FEATURES_EXPECTED)
        rng = np.random.default_rng(0)
        for _ in range(20):
            a = np.stack([rng.integers(0, 9, (4, 2)), rng.integers(0, 8, (4, 2))], axis=-1).astype(np.int32)
            obs, reward, done, infos = env.step(a)
        assert reward.shape == (4,) and np.isfinite(obs).all()
