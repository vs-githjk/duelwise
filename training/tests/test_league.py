import json
from pathlib import Path

import numpy as np
import pytest
import torch

from trainer.bridge import BridgeEnv
from trainer.checkpoint import save_checkpoint
from trainer.ppo import league as L
from trainer.ppo import train_realtime as T
from trainer.ppo.ppo import Agent, compute_gae


def test_fighter_eval_seats_cover_both_seed_lags():
    from trainer.ppo.eval_bots import eval_seats

    for count in (2, 4, 5, 16):
        seats = eval_seats(count)
        assert len(seats) % 4 == 0
        assert np.count_nonzero(seats == 0) == np.count_nonzero(seats == 1)
        for seat in (0, 1):
            assert {index % 2 for index, value in enumerate(seats) if value == seat} == {0, 1}


def test_pfsp_weights_favour_opponents_the_learner_loses_to():
    w = L.pfsp_weights(np.array([0.95, 0.5, 0.1]))
    assert w.sum() == pytest.approx(1.0)
    assert w[2] > w[1] > w[0] > 0  # a beaten opponent still gets some games
    # exactly (1 - p)^2, normalised, above the floor
    raw = np.array([0.0, 0.5, 0.75]) ** 0 * (1 - np.array([0.0, 0.5, 0.75])) ** 2
    assert L.pfsp_weights(np.array([0.0, 0.5, 0.75])) == pytest.approx(raw / raw.sum())


def test_pool_holds_the_16_latest_snapshots_plus_the_bots():
    lg = L.League(rng=np.random.default_rng(0))
    assert [e.name for e in lg.entries()] == list(L.BOT_KINDS)
    for step in range(1, 21):
        lg.add_snapshot(f"s{step}", {"w": torch.zeros(1)}, step)
    snaps = [e for e in lg.entries() if e.kind == "snapshot"]
    assert len(snaps) == 16
    assert [e.step for e in snaps] == list(range(5, 21))
    assert [e.name for e in lg.entries()][:len(L.BOT_KINDS)] == list(L.BOT_KINDS)
    assert len(lg.entries()) == len(L.BOT_KINDS) + 16


def test_sampling_follows_pfsp_weights():
    lg = L.League(rng=np.random.default_rng(1))
    lg.add_snapshot("old", {"w": torch.zeros(1)}, 1)
    for _ in range(100):
        lg.record("random", 1.0)  # learner always beats random
        lg.record("rushdown", 0.0)  # and always loses to rushdown
        lg.record("turtle", 0.5)
        for loop in ("zoner", "throwloop", "backwalk", "pokeloop", "sweepspam", "fireball", "throwtap", "fireball25"):
            lg.record(loop, 1.0)  # the exploit bots are beaten too, so they stay near the floor
        lg.record("old", 1.0)
    picks = [lg.sample().name for _ in range(4000)]
    share = {n: picks.count(n) / len(picks) for n in ("random", "rushdown", "turtle", "old")}
    assert share["rushdown"] > 0.6
    assert share["rushdown"] > 3 * share["turtle"] > 0
    assert 0 < share["random"] < 0.05


def test_frozen_stage_a_snapshots_stay_while_own_ones_roll():
    frozen = [L.Entry(name=f"A{i}", kind="snapshot", step=i, state={"w": torch.zeros(1)}) for i in range(8)]
    lg = L.League(rng=np.random.default_rng(0), max_own=8, frozen=frozen)
    for i in range(12):
        lg.add_snapshot(f"b{i}", {"w": torch.zeros(1)}, 100 + i)
    names = [e.name for e in lg.entries() if e.kind == "snapshot"]
    assert names[:8] == [f"A{i}" for i in range(8)]
    assert names[8:] == [f"b{i}" for i in range(4, 12)]


def test_snapshots_round_trip_on_disk_and_only_the_latest_load(tmp_path):
    for step in (1_000, 20_000, 300_000):
        L.save_snapshot(tmp_path, "A", step, {"w": torch.full((1,), float(step))})
    got = L.load_snapshots(tmp_path, latest=2)
    assert [e.step for e in got] == [20_000, 300_000]
    assert float(got[1].state["w"]) == 300_000.0
    assert L.load_snapshots(tmp_path / "missing", latest=4) == []


def test_gae_matches_a_hand_computed_episode():
    # One env, two steps, reward 1 each, value 0, the episode ends after step 2.
    r = np.array([[1.0], [1.0]], np.float32)
    v = np.zeros((2, 1), np.float32)
    dones = np.array([[0.0], [0.0]], np.float32)  # dones[t]: flag that came with obs[t]
    adv, ret = compute_gae(r, v, dones, next_value=np.zeros(1, np.float32), next_done=np.ones(1, np.float32), gamma=0.5, lam=1.0)
    # t=1: delta = 1 (terminal, no bootstrap); t=0: delta = 1 + 0.5*0 -> next value 0 => 1 + 0.5 * adv1
    assert adv[1, 0] == pytest.approx(1.0)
    assert adv[0, 0] == pytest.approx(1.0 + 0.5 * 1.0)
    assert ret[0, 0] == pytest.approx(adv[0, 0])


def _write_stage_a_ckpt(tmp_path: Path) -> tuple[Path, Agent]:
    torch.manual_seed(3)
    a = Agent(143, (9, 7))
    p = save_checkpoint(tmp_path / "A", 5_000_000, a, None, extra={"stage": "A", "level": "champion"})
    return p, a


def test_stage_a_is_the_champion_and_stage_b_loads_stage_a_weights_with_its_level(tmp_path):
    ckpt, src = _write_stage_a_ckpt(tmp_path)
    a = T.make_stage("A", None, None)
    assert (a.stage, a.level, a.env_level, a.init) == ("A", "champion", "champion", None)
    for lvl in ("hard", "medium", "easy"):
        b = T.make_stage("B", lvl, ckpt)
        assert (b.stage, b.level, b.env_level) == ("B", lvl, lvl)
        agent = T.build_agent(b, obs_size=143, nvec=(9, 7))
        for k, v in src.state_dict().items():
            assert torch.equal(agent.state_dict()[k], v)
    with pytest.raises(ValueError):
        T.make_stage("B", "champion", ckpt)
    with pytest.raises(ValueError):
        T.make_stage("B", "hard", None)  # stage B always starts from a Champion checkpoint


def test_the_stage_level_limiter_is_applied_in_the_env():
    # Easy sees the world 18 frames late, the Champion 3: after one 4 frame decision the timer
    # feature has moved for the Champion and not yet for Easy.
    def timer_moved(level: str) -> bool:
        with BridgeEnv("fighter", 1, seed=5, level=level) as env:
            a = env.reset()
            b, *_ = env.step(np.zeros((1, 2, 2), np.int32))
        return bool(np.abs(a - b).sum() > 0)

    assert timer_moved("champion")
    assert not timer_moved("easy")


def test_stage_plan_runs_morning_then_full_in_order():
    budgets = {"morning": {"stageA": 100, "hard": 30, "medium": 30, "easy": 30}, "full": {"stageA": 400, "hard": 150, "medium": 150, "easy": 60}}
    plan = T.stage_plan(budgets)
    assert [(p.phase, p.key, p.target) for p in plan] == [
        ("morning", "A", 100), ("morning", "hard", 30), ("morning", "medium", 30), ("morning", "easy", 30),
        ("full", "A", 400), ("full", "hard", 150), ("full", "medium", 150), ("full", "easy", 60),
    ]


def test_add_snapshot_replaces_an_entry_with_the_same_name():
    lg = L.League(rng=np.random.default_rng(0))
    lg.add_snapshot("snap-A-0018022400", {"w": 1}, 18022400)
    lg.record("snap-A-0018022400", 1.0)
    new = lg.add_snapshot("snap-A-0018022400", {"w": 2}, 18022400)
    names = [e.name for e in lg.entries()]
    assert names.count("snap-A-0018022400") == 1
    assert lg.get("snap-A-0018022400") is new and new.state == {"w": 2}


# ---------------------------------------------------------------- R15 (T8b)


def _env_obs_size(game: str) -> int:
    with BridgeEnv(game, 1, seed=1) as env:
        return int(env.obs_shape[-1])


@pytest.mark.parametrize("game", ["fighter", "arena"])
def test_a_widened_pre_r15_policy_gives_identical_logits_on_the_old_features(game):
    from trainer.ppo.widen import widen_state

    spec = T.GAMES[game]
    old_obs = _env_obs_size(game) - (19 if game == "fighter" else 17)
    torch.manual_seed(5)
    old = Agent(old_obs, spec.legacy_nvec)
    new = T.agent_from_state(old.state_dict(), spec.nvec, legacy_nvec=spec.legacy_nvec, obs_size=_env_obs_size(game))
    assert new.nvec == spec.nvec and new.obs_size == old_obs + (19 if game == "fighter" else 17)
    x = torch.randn(32, old_obs)
    x_new = torch.cat([x, torch.randn(32, new.obs_size - old_obs)], dim=1)  # the new own-input features are ignored
    lo_old = torch.split(old.actor(old.trunk(x)), list(spec.legacy_nvec), dim=-1)
    lo_new = torch.split(new.actor(new.trunk(x_new)), list(spec.nvec), dim=-1)
    for a, b, f, t in zip(lo_old, lo_new, spec.legacy_nvec, spec.nvec):
        assert torch.equal(a, b[:, :f])  # the old values are untouched
        assert (b[:, f:] < a.min()).all() if t > f else True  # a new keep value starts rare
    assert torch.equal(old.value(x), new.value(x_new))
    with pytest.raises(ValueError):
        widen_state(old.state_dict(), old_obs - 1, spec.legacy_nvec, spec.nvec)


def test_native_nvec_tells_old_and_new_checkpoints_apart():
    s = T.GAMES["fighter"]
    assert T.native_nvec(Agent(10, s.legacy_nvec).state_dict(), "fighter") == s.legacy_nvec
    assert T.native_nvec(Agent(10, s.nvec).state_dict(), "fighter") == s.nvec
    with pytest.raises(ValueError):
        T.native_nvec(Agent(10, (3, 3)).state_dict(), "fighter")


def test_stage_b_entropy_bonus_anneals_and_stage_a_keeps_its_value(tmp_path):
    paths = T.RunPaths(tmp_path / "ckpt", tmp_path / "league", [], tmp_path)
    a = T.Trainer("fighter", T.make_stage("A", None, None), paths, procs=1, envs_per_proc=2, log=lambda *_: None)
    assert a._ppo_now(1000).ent_coef == a.ppo.ent_coef
    ckpt, _ = _write_stage_a_ckpt(tmp_path)
    b = T.Trainer("fighter", T.make_stage("B", "hard", ckpt), paths, procs=1, envs_per_proc=2, log=lambda *_: None)
    seen = []
    for step in (0, 500, 1000, 5000):
        b.step = step
        seen.append(b._ppo_now(1000).ent_coef)
    assert seen[0] == pytest.approx(0.01) and seen[1] == pytest.approx(0.0055) and seen[2] == pytest.approx(0.001) and seen[3] == pytest.approx(0.001)
    assert b._ppo_now(1000).clip_coef == b.ppo.clip_coef  # only the entropy bonus changes


class _FakeEnv:
    """Env i finishes a match every (i + 1) steps: short matches finish first, like the real env."""

    def __init__(self, game, n, seed=0, level=None):
        self.n, self.t = n, 0

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def reset(self):
        return np.zeros((self.n, 2, 4), np.float32)

    def step(self, act):
        self.t += 1
        self.last_act = act.copy()
        infos = [{"env": i, "winner": (i // 2) % 2, "score": [2, 0] if (i // 2) % 2 == 0 else [0, 2]} for i in range(self.n) if self.t % (i + 1) == 0]
        return np.zeros((self.n, 2, 4), np.float32), np.zeros(self.n, np.float32), np.zeros(self.n, np.uint8), infos


def test_eval_counts_the_first_k_matches_per_env_and_balances_the_seats(monkeypatch):
    from trainer.ppo import eval_bots as E

    monkeypatch.setattr(E, "BridgeEnv", _FakeEnv)
    agent = Agent(4, (9, 8))
    r = E.evaluate(agent, "rushdown", 12, n_envs=4)
    # 4 envs x k = 3 matches, even though env 0 finishes many more matches than env 3 in the same time.
    assert r["games"] == 12
    # Each env's winner matches the learner's seat, including both lag parities for each seat.
    assert (r["wins"], r["losses"]) == (12, 0)


def test_eval_puts_the_bot_on_the_other_seat(monkeypatch):
    from trainer.ppo import eval_bots as E

    holder = {}

    class Spy(_FakeEnv):
        def step(self, act):
            holder["act"] = act.copy()
            return super().step(act)

    monkeypatch.setattr(E, "BridgeEnv", Spy)
    E.evaluate(Agent(4, (9, 8)), "turtle", 4, n_envs=4)
    act = holder["act"]
    assert (act[:2, 1, 0] == -3).all() and (act[2:, 0, 0] == -3).all()


LOOPS_BEATEN = {"zoner": 0.9, "throwloop": 0.9, "backwalk": 0.9, "pokeloop": 0.9, "sweepspam": 0.9, "fireball": 0.9, "throwtap": 0.9, "fireball25": 0.9}  # R30 exploit bots, all above the Hard bar


def test_the_gate_flags_a_snapshot_that_scores_zero_against_a_bot_and_lists_only_passes(tmp_path, monkeypatch):
    from trainer.ppo import eval_bots as E
    from trainer.ppo import gate as G

    def fake(score_by_bot):
        def ev(agent, bot, games, **kw):
            return {"bot": bot, "games": games, "score": score_by_bot[bot], "roundWinRate": score_by_bot[bot]}
        return ev

    agent = Agent(4, (9, 8))
    monkeypatch.setattr(E, "evaluate", fake({"random": 1.0, "rushdown": 0.0, "turtle": 0.9, **LOOPS_BEATEN}))
    bad = G.gate_check(agent, "fighter", "hard")
    assert bad["passed"] is False and bad["bots"]["rushdown"]["passed"] is False and bad["bots"]["turtle"]["passed"] is True
    G.record_gate(tmp_path, "fighter", "hard", 2_000_000, bad, agent.state_dict())
    assert not (tmp_path / "levels" / "gated.json").exists() and not list((tmp_path / "gated").glob("**/*.pt"))
    assert json.loads((tmp_path / "gates" / "hard.jsonl").read_text().splitlines()[0])["passed"] is False

    monkeypatch.setattr(E, "evaluate", fake({"random": 0.97, "rushdown": 0.7, "turtle": 0.65, **LOOPS_BEATEN}))
    good = G.gate_check(agent, "fighter", "hard")
    assert good["passed"] is True
    G.record_gate(tmp_path, "fighter", "hard", 4_000_000, good, agent.state_dict())
    gated = json.loads((tmp_path / "levels" / "gated.json").read_text())
    assert gated["levels"]["hard"]["step"] == 4_000_000 and Path(gated["levels"]["hard"]["path"]).exists()
    assert len(L.load_snapshots(tmp_path / "gated" / "hard")) == 1


def test_publish_bars_are_the_r15_numbers():
    from trainer.ppo import gate as G

    assert [G.bar_for("fighter", "hard", b) for b in ("rushdown", "turtle", "random")] == [0.60, 0.60, 0.95]
    assert [G.bar_for("fighter", "medium", b) for b in ("rushdown", "turtle", "random")] == [0.50, 0.50, 0.90]
    assert [G.bar_for("arena", "easy", b) for b in ("rusher", "holder", "random")] == [0.35, 0.35, 0.85]
    assert G.bar_for("fighter", "champion", "rushdown") == 0.75 and G.bar_for("fighter", "champion", "random") is None


def test_a_pre_r15_stage_a_snapshot_plays_as_a_frozen_opponent_in_the_v2_env(tmp_path):
    # The Champion's own snapshots (pre-R15) must load as opponents next to a v2 learner and never pick keep.
    spec = T.GAMES["fighter"]
    old = Agent(_env_obs_size("fighter") - 19, spec.legacy_nvec)
    L.save_snapshot(tmp_path / "A", "A", 1000, old.state_dict())
    ckpt = save_checkpoint(tmp_path / "ckA", 5_000_000, old, None, extra={"stage": "A", "level": "champion"})
    paths = T.RunPaths(tmp_path / "ckpt", tmp_path / "league", [tmp_path / "A"], tmp_path)
    tr = T.Trainer("fighter", T.make_stage("B", "hard", ckpt), paths, procs=1, envs_per_proc=4, log=lambda *_: None, gate_enabled=False)
    step = tr.run(1024)
    assert step >= 1024
    assert tr.agent.nvec == spec.nvec and tr.agent.obs_size == _env_obs_size("fighter")
    snap = next(e for e in tr.league.entries() if e.name == "snap-A-0000001000")
    net = tr._opp_net(snap)
    probs = torch.softmax(net.actor(net.trunk(torch.randn(256, net.obs_size)))[:, 9:], dim=-1)
    assert probs[:, 7].max() < 1e-6


def test_the_b2_job_trains_each_level_gates_it_and_lists_the_newest_checkpoints(tmp_path, monkeypatch):
    from trainer.ppo import eval_bots as E

    # A tiny Champion run to start from (pre-R15 sizes, as the real fighter-league left it).
    spec = T.GAMES["fighter"]
    champ = tmp_path / "champ"
    old = Agent(_env_obs_size("fighter") - 19, spec.legacy_nvec)
    save_checkpoint(champ / "ckpt" / "A", 4096, old, None, extra={"stage": "A", "level": "champion"})
    L.save_snapshot(champ / "league" / "A", "A", 4096, old.state_dict())
    monkeypatch.setattr(E, "evaluate", lambda agent, bot, games, **kw: {"bot": bot, "games": games, "score": 1.0, "roundWinRate": 1.0})
    run = tmp_path / "b2"
    T.run_b2("fighter", run, champion_run=champ, b_steps=(2048, 2048, 2048), b_seconds=(120, 120, 120), procs=1, envs_per_proc=8,
             snapshot_every=1024, gate_every=1024, gate_games=4, log=lambda *_: None)
    levels = json.loads((run / "levels" / "b2.json").read_text())["levels"]
    assert set(levels) == {"hard", "medium", "easy"} and all(Path(v["path"]).exists() for v in levels.values())
    for k in ("hard", "medium", "easy"):
        info = torch.load(levels[k]["path"], map_location="cpu", weights_only=False)
        assert info["extra"]["level"] == k and info["extra"]["obsSize"] == _env_obs_size("fighter") and info["extra"]["nvec"] == list(spec.nvec)
        assert (run / "gates" / f"{k}.jsonl").exists()
    gated = json.loads((run / "levels" / "gated.json").read_text())["levels"]
    assert set(gated) == {"hard", "medium", "easy"}
    # A rerun is a no-op: every stage is marked done.
    T.run_b2("fighter", run, champion_run=champ, b_steps=(2048, 2048, 2048), b_seconds=(120, 120, 120), procs=1, envs_per_proc=8,
             snapshot_every=1024, log=lambda *_: None)
    assert json.loads((run / "levels" / "b2.json").read_text())["levels"] == levels


def test_fighter_bot_order_matches_the_env_sentinels_and_has_the_exploit_bots():
    # -1 - index is what the env reads (FIGHTER_BOT_KINDS in games/fighter/bots.ts): append only.
    assert L.BOT_KINDS == ("random", "rushdown", "turtle", "zoner", "throwloop", "backwalk", "pokeloop", "sweepspam", "fireball", "throwtap", "fireball25")
    assert L.bot_action("zoner")[0] == -4 and L.bot_action("backwalk")[0] == -6
    assert L.bot_action("pokeloop")[0] == -7 and L.bot_action("sweepspam")[0] == -8 and L.bot_action("fireball")[0] == -9
    assert L.bot_action("throwtap")[0] == -10


def test_gate_has_an_exploit_bar_for_hard_and_champion_only():
    from trainer.ppo import gate as G

    for bot in ("zoner", "throwloop", "backwalk", "pokeloop", "sweepspam", "fireball", "throwtap", "fireball25"):
        assert G.bar_for("fighter", "hard", bot) == 0.60
        assert G.bar_for("fighter", "champion", bot) == 0.75
        assert G.bar_for("fighter", "medium", bot) is None
    assert G.bar_for("fighter", "hard", "turtle") == 0.60


def test_gate_check_covers_every_fighter_bot_with_a_bar():
    from trainer.ppo import gate as G

    import trainer.ppo.eval_bots as E

    seen = []

    orig = E.evaluate
    E.evaluate = lambda agent, bot, games, **kw: (seen.append(bot), {"score": 1.0, "games": games})[1]
    try:
        r = G.gate_check(None, "fighter", "champion", games_per_bot=4)
    finally:
        E.evaluate = orig
    assert seen == ["rushdown", "turtle", "zoner", "throwloop", "backwalk", "pokeloop", "sweepspam", "fireball", "throwtap", "fireball25"]
    assert r["passed"]


def test_b3_plan_orders_champion_before_hard_and_picks_newest_b2_checkpoints(tmp_path):
    for sub, steps in (("fighter-league/ckpt/A", (10, 30)), ("fighter-league-b2/ckpt/hard", (5, 9))):
        d = tmp_path / sub
        d.mkdir(parents=True)
        for st in steps:
            (d / f"ckpt-{st:010d}.pt").write_bytes(b"x")
    plan = T.b3_inits(tmp_path / "fighter-league", tmp_path / "fighter-league-b2")
    assert [k for k, _ in plan] == ["A", "hard"]
    assert plan[0][1].name.endswith("30.pt") and plan[1][1].name.endswith("9.pt")


def test_a_snapshot_that_loses_to_the_zoner_does_not_pass_even_if_the_old_three_bots_are_beaten(tmp_path, monkeypatch):
    from trainer.ppo import eval_bots as E
    from trainer.ppo import gate as G

    scores = {"random": 1.0, "rushdown": 1.0, "turtle": 0.9, "zoner": 0.0, "throwloop": 0.9, "backwalk": 0.9, "pokeloop": 0.9, "sweepspam": 0.9, "fireball": 0.9, "throwtap": 0.9, "fireball25": 0.9}
    monkeypatch.setattr(E, "evaluate", lambda agent, bot, games, **kw: {"bot": bot, "games": games, "score": scores[bot]})
    r = G.gate_check(Agent(4, (9, 8)), "fighter", "hard")
    assert r["passed"] is False and r["bots"]["zoner"]["passed"] is False
    G.record_gate(tmp_path, "fighter", "hard", 1, r, Agent(4, (9, 8)).state_dict())
    assert not (tmp_path / "levels" / "gated.json").exists()


def test_b3_arena_plan_retrains_hard_then_easy_from_the_newest_b2_checkpoints(tmp_path):
    for sub, steps in (("arena-league-b2/ckpt/hard", (5, 9)), ("arena-league-b2/ckpt/easy", (2, 4))):
        d = tmp_path / sub
        d.mkdir(parents=True)
        for st in steps:
            (d / f"ckpt-{st:010d}.pt").write_bytes(b"x")
    plan = T.b3_inits(tmp_path / "arena-league-b2", tmp_path / "arena-league-b2", ("hard", "easy"))
    assert [k for k, _ in plan] == ["hard", "easy"]
    assert plan[0][1].name.endswith("9.pt") and plan[1][1].name.endswith("4.pt")
    with pytest.raises(ValueError):
        T.b3_inits(tmp_path, tmp_path, ("nope",))


def test_the_arena_league_and_gate_know_the_human_proxy_bots():
    from trainer.ppo import gate as G

    assert L.BOTS["arena"] == ("random", "rusher", "holder", "peeker", "strafe", "holdangle", "human-proxy")
    assert L.bot_action("human-proxy", 9, "arena")[0] == -7
    assert L.bot_action("holdangle", 9, "arena")[0] == -6
    assert "human-proxy" not in L.TRAINING_BOTS["arena"]
    league = L.League(rng=np.random.default_rng(7), bots=L.TRAINING_BOTS["arena"])
    assert all(league.sample().name != "human-proxy" for _ in range(500))
    for bot in L.BOTS["arena"]:
        G.bar_for("arena", "easy", bot)
    assert G.bar_for("arena", "easy", "human-proxy") is None
    for level, bar in (("easy", 0.35), ("medium", 0.5), ("hard", 0.6), ("champion", 0.75)):
        for bot in ("peeker", "strafe", "holdangle"):
            assert G.bar_for("arena", level, bot) == bar


def test_b4_plan_continues_champion_and_hard_from_the_newest_b3_checkpoints(tmp_path):
    # KC1: fighter-league-b4 retrains from fighter-league-b3 for both stages (--champion-run and --b2-run name the same run).
    for sub, steps in (("fighter-league-b3/ckpt/A", (10, 30)), ("fighter-league-b3/ckpt/hard", (5, 29))):
        d = tmp_path / sub
        d.mkdir(parents=True)
        for st in steps:
            (d / f"ckpt-{st:010d}.pt").write_bytes(b"x")
    plan = T.b3_inits(tmp_path / "fighter-league-b3", tmp_path / "fighter-league-b3")
    assert [k for k, _ in plan] == ["A", "hard"]
    assert plan[0][1].name.endswith("30.pt") and plan[1][1].name.endswith("29.pt")


def test_the_b4_job_file_retrains_champion_then_hard_from_b3_in_two_slots_and_three_hours():
    job = json.loads((Path(__file__).resolve().parents[1] / "jobs" / "fighter-league-b4.json").read_text())
    cmd = job["cmd"]
    assert job["name"] == "fighter-league-b4" and job["cpuSlots"] == 2 and job["maxHours"] == 3
    assert cmd[cmd.index("--champion-run") + 1] == "fighter-league-b3" and cmd[cmd.index("--b2-run") + 1] == "fighter-league-b3"
    assert "--b3" in cmd and job["checkpointDir"] == "runs/fighter-league-b4/ckpt"
    secs = [float(x) for x in cmd[cmd.index("--b3-seconds") + 1].split(",")]
    assert sum(secs) <= job["maxHours"] * 3600


def test_the_arena_b4_job_file_retrains_for_seat_balance_in_two_slots_within_three_hours():
    # KC2: arena-league-b4 continues the b3 Hard and Easy checkpoints (and the b2 Champion) under the seat-1 mirrored observation.
    job = json.loads((Path(__file__).resolve().parents[1] / "jobs" / "arena-league-b4.json").read_text())
    cmd = job["cmd"]
    assert job["name"] == "arena-league-b4" and job["cpuSlots"] == 2 and job["maxHours"] == 3
    assert cmd[cmd.index("--game") + 1] == "arena" and "--b3" in cmd
    assert cmd[cmd.index("--b2-run") + 1] == "arena-league-b3" and cmd[cmd.index("--champion-run") + 1] == "arena-league-b2"
    keys = cmd[cmd.index("--b3-keys") + 1].split(",")
    assert keys == ["A", "hard", "easy"]
    secs = [float(x) for x in cmd[cmd.index("--b3-seconds") + 1].split(",")]
    assert len(secs) == len(keys) and sum(secs) <= job["maxHours"] * 3600
    assert len(cmd[cmd.index("--b3-steps") + 1].split(",")) == len(keys)
    assert job["checkpointDir"] == "runs/arena-league-b4/ckpt"
