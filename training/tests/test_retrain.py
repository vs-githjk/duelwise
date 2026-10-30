"""T24: the learning loop. Self-play runs on the real Bun host with a tiny net; the gate games are injected (the real gate is
packages/agents/src/measure/four-gate.ts, exercised in test_retrain_gate_runs_through_bun)."""

import json
import random
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
import torch

from trainer import cli
from trainer.bridge import find_bun
from trainer.four.net import AZNet
from trainer.four.retrain_adapter import FourRetrainAdapter, RetrainTrainer, SoftReplayBuffer, positions_of
from trainer.paths import worktree_root
from trainer.registry import load_registry, validate_registry
from trainer.retrain import NoAdapter, load_adapters, retrain

REPO = worktree_root(Path(__file__).resolve().parent)
ROWS, COLS = 6, 7


def random_game(rng: random.Random) -> list[int]:
    """A legal, finished Four in a Row game (random columns until four in a row, a full board or 40 plies)."""
    board = [[0] * COLS for _ in range(ROWS)]
    heights = [0] * COLS
    moves: list[int] = []
    while True:
        col = rng.choice([c for c in range(COLS) if heights[c] < ROWS])
        seat = len(moves) % 2 + 1
        r = heights[col]
        board[r][col] = seat
        heights[col] += 1
        moves.append(col)
        for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
            n = 1
            for sgn in (1, -1):
                rr, cc = r + sgn * dr, col + sgn * dc
                while 0 <= rr < ROWS and 0 <= cc < COLS and board[rr][cc] == seat:
                    n += 1
                    rr, cc = rr + sgn * dr, cc + sgn * dc
            if n >= 4:
                return moves
        if len(moves) == ROWS * COLS:
            return moves


class SyntheticExport(FourRetrainAdapter):
    """Writes 30 synthetic human matches where the real adapter would read the database (that path has its own TS test)."""

    points = 240
    gate_calls = 0

    def export_matches(self, out_dir: Path) -> dict:
        rng = random.Random(7)
        games = []
        while len(games) < 30:
            g = random_game(rng)
            if len(g) >= 8:
                games.append(g)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "matches.jsonl").write_text("".join(json.dumps({"id": f"m{i}", "level": "hard", "agentVersion": "v1", "humanSeat": 0, "winner": None, "moves": g}) + "\n" for i, g in enumerate(games)))
        positions = [g[:k] for g in games for k in range(4, len(g) - 1)]
        (out_dir / "starts.json").write_text(json.dumps({"game": "four", "positions": positions}) + "\n")
        summary = {"game": "four", "total": 30, "kept": 30, "rejected": {}, "humanMatches": 30, "startPositions": len(positions)}
        (out_dir / "summary.json").write_text(json.dumps(summary))
        return summary

    def play_gate(self, *, challenger, reg, games, sims, processes):
        type(self).gate_calls += 1
        return float(self.points), 400, {"sims": sims, "harness": "bun", "opponent": "forced by the test"}


def v1_registry() -> dict:
    """A Four in a Row registry with one measured version, v1 (the shape packages/agents/registry/four.json had before any retrain)."""
    def block(level, value, lo, hi, n, opp, elo):
        return {"metric": f"score vs {opp}", "value": value, "ci95": [lo, hi], "n": n, "opponents": opp, "siteElo": elo,
                "measuredAt": "2026-10-22T08:33:42.248Z", "harness": "bun", "commit": "abc1234"}

    return {
        "game": "four", "champion": "v1",
        "versions": [{"version": "v1", "parent": None, "createdAt": "2026-10-22T08:33:42.248Z", "promotedAt": "2026-10-22T08:33:42.248Z",
                      "status": "measured", "artifacts": {l: f"apps/web/public/agents/four/v1/{l}.onnx" for l in ("easy", "medium", "hard", "champion")},
                      "sha256": {"champion": "0" * 64}, "trainedSteps": 2842, "humanMatchesUsed": 0, "gate": None}],
        "levels": {l: {"version": "v1", "config": {"model": f"{l}.onnx", "sims": 800 if l == "champion" else 0, "snapshot": "snap-00006144"}}
                   for l in ("easy", "medium", "hard", "champion")},
        "measured": {"easy": block("easy", 0.93, 0.9, 0.95, 400, "random legal moves", 1000.0),
                     "medium": block("medium", 0.87, 0.8, 0.92, 100, "easy", 1330.0),
                     "hard": block("hard", 0.775, 0.7, 0.84, 100, "medium", 1545.0),
                     "champion": block("champion", 0.735, 0.65, 0.81, 100, "hard", 1722.0)},
        "unpublished": {}, "unpublishedConfig": {}, "learnsFromHumans": True,
    }


@pytest.fixture()
def world(tmp_path):
    root = tmp_path / "root"
    (root / "packages/agents/registry").mkdir(parents=True)
    (root / "packages/agents/registry/four.json").write_text(json.dumps(v1_registry(), indent=2) + "\n")
    real = load_adapters(REPO)["four"]
    (root / "packages/agents/registry/adapters.json").write_text(json.dumps({"four": {**real, "learns": False}}, indent=2) + "\n")
    champ = root / "apps/web/public/agents/four/v1"
    champ.mkdir(parents=True)
    (champ / "champion.onnx").write_bytes(b"champion-bytes")
    net = AZNet(2, 16)
    pt = tmp_path / "champion.pt"
    torch.save({"model": net.state_dict(), "games_total": 100, "steps": 50, "arch": [2, 16]}, pt)
    SyntheticExport.gate_calls = 0
    adapter = SyntheticExport(root=root, champion_pt=pt, games_per_iter=8, parallel=8, sims=8, workers=1, batch=32, window_games=100)
    return {"root": root, "runs": tmp_path / "runs", "adapter": adapter}


def run(world, points=240, smoke=False):
    world["adapter"].points = points
    return retrain("four", 0, smoke=smoke, root=world["root"], runs=world["runs"], adapter=world["adapter"], log=lambda *_: None)


def reg_of(world):
    return load_registry(world["root"] / "packages/agents/registry/four.json")


def test_challenger_trains_on_a_tiny_budget_and_a_forced_060_promotes(world):
    before = reg_of(world)
    row = run(world, points=240)  # 240 of 400 = 0.60
    assert row["promoted"] and row["gate"]["passed"] and row["gate"]["score"] == 0.6
    assert row["training"]["rounds"] >= 1 and row["training"]["selfPlayGames"] >= 8 and row["humanMatchesUsed"] == 30

    reg = reg_of(world)
    assert validate_registry(reg) == []
    assert reg["champion"] == "v2" and reg["levels"]["champion"]["version"] == "v2"
    v2 = next(v for v in reg["versions"] if v["version"] == "v2")
    assert v2["parent"] == "v1" and v2["status"] == "measured" and v2["promotedAt"] and v2["humanMatchesUsed"] == 30
    assert v2["gate"]["passed"] and v2["gate"]["n"] == 400
    pub = world["root"] / v2["artifacts"]["champion"]
    assert pub.exists() and pub.parent.name == "v2"
    import hashlib
    assert hashlib.sha256(pub.read_bytes()).hexdigest() == v2["sha256"]["champion"]
    m = reg["measured"]["champion"]
    assert m["opponents"] == "v1 champion" and m["value"] == 0.6 and m["siteElo"] > before["measured"]["champion"]["siteElo"]
    # the other levels and v1 are untouched
    for level in ("easy", "medium", "hard"):
        assert reg["levels"][level] == before["levels"][level] and reg["measured"][level] == before["measured"][level]
    assert reg["versions"][0] == before["versions"][0]

    rows = [json.loads(x) for x in (world["runs"] / "retrain/four/training_runs.jsonl").read_text().splitlines()]
    assert len(rows) == 1 and rows[0]["promoted"] is True and rows[0]["challenger"] == "v2" and rows[0]["champion"] == "v1"
    assert rows[0]["humanMatchesUsed"] == 30
    # claim C11: learns turns on only once a promoted version used human matches
    assert load_adapters(world["root"])["four"]["learns"] is True


def test_a_forced_052_does_not_promote_but_leaves_a_candidate_in_the_history(world):
    before = reg_of(world)
    row = run(world, points=208)  # 208 of 400 = 0.52, lower bound under 0.5
    assert not row["promoted"] and not row["gate"]["passed"]
    assert any("below 0.55" in r or "lower bound" in r for r in row["gate"]["reasons"])
    reg = reg_of(world)
    assert validate_registry(reg) == []
    assert reg["champion"] == "v1" and reg["levels"] == before["levels"] and reg["measured"] == before["measured"]
    v2 = next(v for v in reg["versions"] if v["version"] == "v2")
    assert v2["status"] == "candidate" and v2["promotedAt"] is None and v2["gate"]["passed"] is False
    assert not (world["root"] / "apps/web/public/agents/four/v2").exists()
    assert (world["runs"] / "retrain/four/v2/champion.onnx").exists()
    assert load_adapters(world["root"])["four"]["learns"] is False
    assert json.loads((world["runs"] / "retrain/four/training_runs.jsonl").read_text().splitlines()[0])["promoted"] is False


def test_the_gate_needs_400_games(world):
    adapter = world["adapter"]
    adapter.play_gate = lambda **kw: (300.0, 399, {"sims": 1})
    row = retrain("four", 0, root=world["root"], runs=world["runs"], adapter=adapter, log=lambda *_: None)
    assert not row["promoted"] and "only 399 games" in row["gate"]["reasons"][0]


def test_smoke_never_promotes_never_plays_the_gate_and_never_touches_the_registry(world):
    path = world["root"] / "packages/agents/registry/four.json"
    before, adapters_before = path.read_bytes(), (world["root"] / "packages/agents/registry/adapters.json").read_bytes()
    row = run(world, points=400, smoke=True)  # would pass any gate, if one were played
    assert row["smoke"] and not row["promoted"] and not row["registryChanged"]
    assert SyntheticExport.gate_calls == 0
    assert path.read_bytes() == before and (world["root"] / "packages/agents/registry/adapters.json").read_bytes() == adapters_before
    logged = json.loads((world["runs"] / "retrain/four/training_runs.jsonl").read_text().splitlines()[0])
    assert logged["smoke"] is True and logged["promoted"] is False


def test_a_game_without_an_adapter_exits_with_a_clear_message(world, capsys, monkeypatch):
    assert cli.main(["retrain", "--game", "chess", "--smoke"]) == 2
    err = capsys.readouterr().err
    assert "chess has no retrain adapter yet" in err and "Nothing was trained" in err and "four" in err
    with pytest.raises(NoAdapter):
        retrain("holdem", 0, root=world["root"], runs=world["runs"])


def test_human_start_positions_enter_self_play_and_their_values_are_search_corrected(tmp_path):
    starts = tmp_path / "starts.json"
    starts.write_text(json.dumps({"game": "four", "positions": [[3, 3, 2, 4], [3, 2, 3, 2, 3, 2]]}))
    tr = RetrainTrainer(2, 16, 1e-3, 100, seed=3)
    games = tr.selfplay(6, 6, 8, seed=5, extra=["--starts", str(starts), "--start-share", "1"], workers=1)
    assert all(g["prefix"] in ([3, 3, 2, 4], [3, 2, 3, 2, 3, 2]) for g in games)
    assert all(len(g["moves"]) == len(g["visits"]) == len(g["q"]) for g in games)
    # no starts file: nothing changes, games begin on the empty board
    plain = tr.selfplay(2, 2, 8, seed=5, workers=1)
    assert all("prefix" not in g for g in plain)

    g = {"prefix": [3, 3, 2, 4], "moves": [1, 0], "visits": [[0, 8, 0, 0, 0, 0, 0], [8, 0, 0, 0, 0, 0, 0]], "q": [0.5, -0.25], "winner": 0, "truncated": False}
    buf = SoftReplayBuffer(10, q_mix=0.5)
    assert buf.add_games([g]) == 2  # rows only for the searched plies
    _, _, z = buf._arrays()
    mover_is_seat0 = [1.0, -1.0]  # ply 4 is seat 0's, ply 5 seat 1's; seat 0 won
    assert np.allclose(z.astype(np.float32), [0.5 * mover_is_seat0[0] + 0.5 * 0.5, 0.5 * mover_is_seat0[1] + 0.5 * -0.25], atol=1e-3)
    plain_game = {"moves": [3, 3, 2], "visits": [[1] * 7] * 3, "winner": 0, "truncated": False}
    buf2 = SoftReplayBuffer(10)
    buf2.add_games([plain_game])
    assert set(buf2._arrays()[2].astype(np.float32).tolist()) <= {-1.0, 1.0}


def test_positions_of_matches_the_ts_filter():
    assert positions_of(list(range(12))) == 7 and positions_of([1, 2, 3]) == 0


def test_the_real_registry_files_are_valid_and_round_trip():
    for game in ("four", "chess", "holdem", "word"):
        p = REPO / "packages/agents/registry" / f"{game}.json"
        reg = load_registry(p)
        assert validate_registry(reg) == []
        assert json.dumps(reg, indent=2, ensure_ascii=False) + "\n" == p.read_text()
    adapters = load_adapters(REPO)
    assert adapters["four"]["adapter"] == "trainer.four.retrain_adapter"


def test_the_gate_script_plays_a_challenger_against_a_champion_through_bun(tmp_path):
    onnx = REPO / "apps/web/public/agents/four/v1/champion.onnx"
    if not onnx.exists():
        pytest.skip("no published champion model in this checkout")
    p = subprocess.run([find_bun(), str(REPO / "packages/agents/src/measure/four-gate.ts"), "--challenger", str(onnx), "--champion", str(onnx),
                        "--games", "4", "--sims", "8", "--processes", "2"], capture_output=True, text=True, timeout=300)
    assert p.returncode == 0, p.stderr[-400:]
    out = json.loads(p.stdout.strip().splitlines()[-1])
    assert out["n"] == 4 and out["sims"] == 8 and 0 <= out["points"] <= 4
