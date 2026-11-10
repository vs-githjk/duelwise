"""Air hockey (puck) trainer wiring (P4): action heads, bot sentinels, gate bars and the job files."""

import json
import subprocess
from pathlib import Path

import pytest

from trainer.bridge import BridgeEnv, find_bun
from trainer.ppo import gate as G
from trainer.ppo import league as L
from trainer.ppo import train_realtime as T

ROOT = Path(__file__).resolve().parents[2]
JOBS = ROOT / "training" / "jobs"


def _env_bot_kinds() -> list[str]:
    code = "import { PUCK_BOT_KINDS } from './packages/core/src/games/puck/env'; console.log(JSON.stringify(PUCK_BOT_KINDS))"
    out = subprocess.run([find_bun(), "-e", code], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return json.loads(out.strip().splitlines()[-1])


def test_the_puck_game_spec_has_two_bin_heads():
    spec = T.game_spec("puck")
    assert spec.nvec == (11, 9) and spec.legacy_nvec == (11, 9)
    assert spec.ent_anneal == (0.01, 0.001)


def test_the_bridge_env_matches_the_spec_heads():
    with BridgeEnv("puck", 2, seed=1, level="champion") as env:
        assert env.action_dims == len(T.GAMES["puck"].nvec)


def test_bot_sentinels_follow_the_env_bot_order():
    kinds = _env_bot_kinds()
    assert list(L.BOTS["puck"]) == kinds == ["random", "striker", "goalie", "banker", "shadow"]
    assert list(L.TRAINING_BOTS["puck"]) == kinds
    for i, kind in enumerate(kinds):
        assert L.bot_action(kind, 2, "puck") == [-1 - i, 0]


def test_a_sentinel_plays_the_named_bot_over_the_bridge():
    import numpy as np

    with BridgeEnv("puck", 1, seed=3, level="champion") as env:
        env.reset()
        act = np.zeros((1, 2, 2), np.int32)
        for kind in L.BOTS["puck"]:
            act[0, 0] = L.bot_action(kind, 2, "puck")
            act[0, 1] = L.bot_action("random", 2, "puck")
            env.step(act)  # a bad sentinel raises RangeError in the env, which kills the bridge


def test_puck_roles_map_each_bot_once():
    assert G.ROLE["puck"] == {"random": "random", "striker": "rush", "goalie": "turtle", "banker": "bank", "shadow": "shadow"}
    assert set(G.ROLE["puck"]) == set(L.BOTS["puck"])


@pytest.mark.parametrize("level,expected", [
    ("easy", {"random": 0.85, "striker": 0.35, "goalie": 0.35, "banker": None, "shadow": None}),
    ("medium", {"random": 0.90, "striker": 0.50, "goalie": 0.50, "banker": None, "shadow": None}),
    ("hard", {"random": 0.95, "striker": 0.60, "goalie": 0.60, "banker": 0.60, "shadow": 0.60}),
    ("champion", {"random": None, "striker": 0.75, "goalie": 0.75, "banker": 0.75, "shadow": 0.75}),
])
def test_puck_gate_bars_equal_the_agents_table(level, expected):
    assert {bot: G.bar_for("puck", level, bot) for bot in L.BOTS["puck"]} == expected


def test_fighter_and_arena_bars_are_unchanged():
    assert G.PUBLISH_BARS["hard"]["rush"] == 0.60 and G.PUBLISH_BARS["hard"]["random"] == 0.95
    assert G.PUBLISH_BARS["easy"] == {"rush": 0.35, "turtle": 0.35, "random": 0.85, "peek": 0.35, "strafe": 0.35, "holdangle": 0.35}
    assert G.PUBLISH_BARS["medium"] == {"rush": 0.50, "turtle": 0.50, "random": 0.90, "peek": 0.50, "strafe": 0.50, "holdangle": 0.50}
    for game in ("fighter", "arena"):
        for level in ("easy", "medium", "hard", "champion"):
            for bot in L.BOTS[game]:
                role = G.ROLE[game][bot]
                assert role not in ("bank",), role
                assert G.bar_for(game, level, bot) == G.PUBLISH_BARS[level].get(role)
    assert G.bar_for("fighter", "champion", "rushdown") == 0.75 and G.bar_for("arena", "hard", "peeker") == 0.60


def test_stage_a_gate_can_be_switched_on_from_the_command_line():
    import inspect

    assert "--gate-stage-a" in inspect.getsource(T.main)


def test_the_puck_job_files_are_well_formed():
    a = json.loads((JOBS / "puck-league-a.json").read_text())
    b = json.loads((JOBS / "puck-league-b-hard.json").read_text())
    assert a["name"] == "puck-league-a" and a["cpuSlots"] == 3 and 2.5 <= a["maxHours"] <= 4 and a["resumeArg"] == "--resume"
    assert b["name"] == "puck-league-b-hard" and b["cpuSlots"] == 2 and 1.5 <= b["maxHours"] <= 3 and b["resumeArg"] == "--resume"
    for job in (a, b):
        assert job["mps"] is False and job["cmd"][:3] == ["scripts/py", "-m", "trainer.ppo.train_realtime"]
        assert job["cmd"][job["cmd"].index("--game") + 1] == "puck"
        assert job["checkpointDir"].startswith(f"runs/{job['name']}/ckpt")
    for job in (a, b):  # the in-process time cap ends the run cleanly before the supervisor's backstop
        assert float(job["cmd"][job["cmd"].index("--max-seconds") + 1]) < job["maxHours"] * 3600
    assert "--gate-stage-a" in a["cmd"] and a["cmd"][a["cmd"].index("--stage") + 1] == "A"
    assert b["cmd"][b["cmd"].index("--stage") + 1] == "B" and b["cmd"][b["cmd"].index("--level") + 1] == "hard"
    assert "--frozen-dir" in b["cmd"]


def test_stage_b_can_start_from_the_gated_champion_listing(tmp_path):
    snap = tmp_path / "snap-champion-0000002000.pt"
    listing = tmp_path / "gated.json"
    listing.write_text(json.dumps({"game": "puck", "levels": {"champion": {"path": str(snap), "step": 2000}}}))
    assert T.make_stage("B", "hard", listing).init == snap
    assert T.make_stage("B", "hard", snap).init == snap  # a plain checkpoint path still works
    listing.write_text(json.dumps({"game": "puck", "levels": {}}))
    with pytest.raises(SystemExit):
        T.make_stage("B", "hard", listing)
