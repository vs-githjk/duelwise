"""Learn-from-humans: the 30 percent mix, the gates, the b2200 fine-tune plumbing, the Four export wiring and the learn command's verdicts."""

import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from test_chess_train import synth_policy
from trainer import gates, human_export, learn
from trainer.chess.data import POLICY_RECORD_BYTES, Shards
from trainer.chess.train_policy import main as policy_main
from trainer.human import MAX_HUMAN_SHARE, HumanShards, MixedSampler, check_share, effective_human_share


def write_human(d: Path, n: int, weights: list[float], seed: int = 3) -> None:
    synth_policy(d, n=n, per_shard=max(n, 1), seed=seed)
    np.asarray(weights, dtype="<f4").tofile(d / "weights.bin")


# --- the 30 percent cap ---------------------------------------------------------------------------------------------------------

def test_share_is_capped_at_thirty_percent():
    assert check_share(0.0) == 0.0 and check_share(0.3) == 0.3
    for bad in (0.31, 0.5, 1.0, -0.1):
        with pytest.raises(ValueError):
            check_share(bad)


def test_few_human_records_shrink_the_share_instead_of_repeating_them():
    assert effective_human_share(0.3, n_human=1_000_000, total_samples=1000) == 0.3
    # 100 records shown at most 3 times each in 10,000 samples: at most 300 samples, 3 percent
    assert effective_human_share(0.3, n_human=100, total_samples=10_000) == pytest.approx(0.03)
    assert effective_human_share(0.3, n_human=0, total_samples=10_000) == 0.0
    with pytest.raises(ValueError):
        effective_human_share(0.4, 10, 10)


def test_mixed_batches_never_exceed_the_cap_and_follow_the_weights(tmp_path):
    synth_policy(tmp_path / "base", n=800, per_shard=800)
    write_human(tmp_path / "human", 200, [1.0] * 100 + [0.0] * 90 + [9.0] * 10)
    base, human = Shards(tmp_path / "base", "policy"), HumanShards(tmp_path / "human")
    rng = np.random.default_rng(0)
    s = MixedSampler(base, human, 0.3, rng, total_samples=64 * 30)
    assert s.share == pytest.approx(0.3)
    batch = s.sample(100)
    assert batch.shape == (100, POLICY_RECORD_BYTES)
    assert human.sample(rng, 500).shape == (500, POLICY_RECORD_BYTES)
    # weight-0 records are never drawn; the ten heavy ones (weight 9, 90 of 190 weight) carry about 47 percent of the draws
    idx = rng.choice(human.n, size=20_000, p=human.p)
    assert not ((idx >= 100) & (idx < 190)).any()
    assert ((idx >= 190).mean()) == pytest.approx(90 / 190, abs=0.02)
    # rounding never lets a small batch pass the cap
    for b in (1, 3, 7, 10, 33):
        s2 = MixedSampler(base, human, 0.3, np.random.default_rng(1), total_samples=10**9)
        n_h = min(int(round(b * s2.share)), int(b * 0.30))
        assert n_h <= 0.3 * b


def test_human_shards_reject_bad_weights(tmp_path):
    write_human(tmp_path / "a", 10, [1.0] * 9)
    with pytest.raises(ValueError, match="weights"):
        HumanShards(tmp_path / "a")
    write_human(tmp_path / "b", 10, [0.0] * 10)
    with pytest.raises(ValueError, match="every weight is 0"):
        HumanShards(tmp_path / "b")
    write_human(tmp_path / "c", 10, [1.0] * 9 + [-1.0])
    with pytest.raises(ValueError, match="not negative"):
        HumanShards(tmp_path / "c")


# --- the gates ------------------------------------------------------------------------------------------------------------------

def seats(p0: float, p1: float, n0: int = 400, n1: int = 400) -> list[dict]:
    return [{"seat": 0, "n": n0, "points": p0}, {"seat": 1, "n": n1, "points": p1}]


def test_seat_gate_needs_400_games_and_a_wilson_bound_above_half_from_each_seat():
    ok = gates.seat_gate(seats(240, 235))
    assert ok["passed"] and ok["bySeat"][0]["ci95"][0] > 0.5
    # a strong average cannot hide a weak colour
    weak = gates.seat_gate(seats(300, 205))
    assert not weak["passed"] and any("seat 1" in r for r in weak["reasons"])
    # 400 games pooled is not 400 from each seat
    few = gates.seat_gate(seats(130, 130, 200, 200))
    assert not few["passed"] and any("only 200 games" in r for r in few["reasons"])
    # a missing seat
    assert not gates.seat_gate([{"seat": 0, "n": 400, "points": 300}])["passed"]
    # the bound is strict: a score of exactly 0.5 never passes
    assert not gates.seat_gate(seats(200, 200))["passed"]


def test_fit_holdout_blocks_a_net_that_fits_expert_moves_worse():
    base = {"val_top1": 0.50, "val_loss": 1.9}
    assert gates.fit_holdout({"val_top1": 0.52, "val_loss": 1.85}, base)["passed"]
    assert not gates.fit_holdout({"val_top1": 0.49, "val_loss": 1.85}, base)["passed"]
    assert not gates.fit_holdout({"val_top1": 0.52, "val_loss": 1.95}, base)["passed"]


def test_play_holdout_is_a_fail_when_human_data_was_used_and_cannot_be_checked():
    assert gates.play_holdout(0, 0, human_matches_used=0, holdout_positions=0)["passed"]
    assert not gates.play_holdout(0, 0, human_matches_used=40, holdout_positions=0)["passed"]
    assert gates.play_holdout(60, 120, human_matches_used=40, holdout_positions=30)["passed"]  # exactly 0.5 is not worse
    assert gates.play_holdout(70, 120, human_matches_used=40, holdout_positions=30)["passed"]
    assert not gates.play_holdout(50, 120, human_matches_used=40, holdout_positions=30)["passed"]
    assert not gates.play_holdout(10, 50, human_matches_used=40, holdout_positions=30)["passed"]  # fewer than 100 games


def test_verdict_and_render():
    good = [{"gate": "a", "passed": True, "reasons": []}]
    bad = good + [{"gate": "b", "passed": False, "reasons": ["why"]}]
    assert gates.verdict(good)["passed"] and "RESULT: PASS" in gates.render("four", good)
    assert not gates.verdict(bad)["passed"] and "RESULT: FAIL" in gates.render("four", bad)
    assert "b: why" in gates.verdict(bad)["reasons"]
    assert not gates.verdict([])["passed"]  # no gates means nothing was checked


def test_pooled_gate_is_the_existing_two_ply_rule():
    ok = gates.pooled_gate(600, 800, 0.7, 0.6, [{"seat": 0, "n": 400, "points": 300}, {"seat": 1, "n": 400, "points": 300}], "x")
    assert ok["passed"]
    low = gates.pooled_gate(500, 800, 0.7, 0.6, [{"seat": 0, "n": 400, "points": 250}, {"seat": 1, "n": 400, "points": 250}], "x")
    assert not low["passed"]
    lopsided = gates.pooled_gate(560, 800, 0.7, 0.6, [{"seat": 0, "n": 400, "points": 380}, {"seat": 1, "n": 400, "points": 180}], "x")
    assert not lopsided["passed"]


# --- the b2200 fine-tune --------------------------------------------------------------------------------------------------------

def test_b2200_finetune_starts_from_b1900_mixes_human_moves_and_writes_a_holdout(tmp_path):
    data = tmp_path / "data"
    synth_policy(data / "b1900", n=600, per_shard=400, seed=1)
    synth_policy(data / "b2200", n=600, per_shard=400, seed=2)
    base_args = ["--run-dir", str(tmp_path / "r1"), "--ckpt-dir", str(tmp_path / "c1"), "--data-dir", str(data), "--buckets", "b1900",
                 "--max-steps", "8", "--batch", "32", "--device", "cpu", "--blocks", "2", "--channels", "8"]
    assert policy_main(base_args) == 0
    write_human(tmp_path / "human", 300, [1.0] * 300)
    args = ["--run-dir", str(tmp_path / "r2"), "--ckpt-dir", str(tmp_path / "c2"), "--data-dir", str(data), "--buckets", "b2200",
            "--init-from", str(tmp_path / "c1" / "b1900"), "--human-dir", str(tmp_path / "human"), "--human-share", "0.3", "--lr", "5e-4",
            "--max-steps", "8", "--batch", "32", "--device", "cpu", "--blocks", "2", "--channels", "8", "--expected-steps", "8"]
    assert policy_main(args) == 0
    h = json.loads((tmp_path / "r2" / "export" / "b2200" / "holdout.json").read_text())
    assert set(h["baseline"]) == {"val_loss", "val_top1"} and set(h["candidate"]) == {"val_loss", "val_top1"}
    assert h["humanRecords"] == 300 and 0 < h["humanShare"] <= MAX_HUMAN_SHARE
    assert (tmp_path / "r2" / "export" / "b2200" / "policy.onnx").exists()
    # over the cap is refused before anything trains
    assert policy_main([*args, "--human-share", "0.5", "--run-dir", str(tmp_path / "r3"), "--ckpt-dir", str(tmp_path / "c3")]) == 1
    assert not (tmp_path / "r3" / "export" / "b2200" / "policy.onnx").exists()


def test_a_missing_human_folder_is_logged_and_the_run_uses_lichess_only(tmp_path, capsys):
    data = tmp_path / "data"
    synth_policy(data / "b1900", n=200, per_shard=200, seed=1)
    synth_policy(data / "b2200", n=200, per_shard=200, seed=2)
    common = ["--data-dir", str(data), "--max-steps", "4", "--batch", "16", "--device", "cpu", "--blocks", "2", "--channels", "8"]
    assert policy_main([*common, "--buckets", "b1900", "--run-dir", str(tmp_path / "r1"), "--ckpt-dir", str(tmp_path / "c1")]) == 0
    assert policy_main([*common, "--buckets", "b2200", "--run-dir", str(tmp_path / "r2"), "--ckpt-dir", str(tmp_path / "c2"),
                        "--init-from", str(tmp_path / "c1" / "b1900"), "--human-dir", str(tmp_path / "none")]) == 0
    assert "training on Lichess games only" in capsys.readouterr().out
    assert json.loads((tmp_path / "r2" / "export" / "b2200" / "holdout.json").read_text())["humanRecords"] == 0


def test_init_from_without_a_checkpoint_is_an_error(tmp_path):
    data = tmp_path / "data"
    synth_policy(data / "b2200", n=100, per_shard=100)
    rc = policy_main(["--run-dir", str(tmp_path / "r"), "--ckpt-dir", str(tmp_path / "c"), "--data-dir", str(data), "--buckets", "b2200",
                      "--init-from", str(tmp_path / "nothing"), "--max-steps", "2", "--batch", "16", "--device", "cpu", "--blocks", "2", "--channels", "8"])
    assert rc == 1


# --- Four export wiring ---------------------------------------------------------------------------------------------------------

def test_four_export_uses_the_postgres_export_when_a_database_url_is_set(tmp_path, monkeypatch):
    from trainer.four import retrain_adapter as ra

    fake_root = tmp_path / "human"

    def fake_export(game, out_root, **kw):
        d = out_root / game
        d.mkdir(parents=True)
        (d / "matches.jsonl").write_text(json.dumps({"id": "a", "moves": [3, 3, 2, 4, 3, 2, 4], "weight": 2}) + "\n" +
                                         json.dumps({"id": "b", "moves": [3, 3, 2, 4, 3, 2, 4], "weight": 0}) + "\n")
        (d / "starts.json").write_text(json.dumps({"game": "four", "positions": [[3, 3, 2, 4], [3, 3, 2, 4, 3]]}))
        (d / "holdout.jsonl").write_text("")
        (d / "holdout-starts.json").write_text(json.dumps({"game": "four", "positions": []}))
        s = {"game": "four", "total": 5, "kept": 3, "training": 2, "holdout": 1, "rejected": {"practice": 2}, "idsSha256": "abc"}
        (d / "summary.json").write_text(json.dumps(s))
        return s

    monkeypatch.setattr(ra, "export_human", fake_export)
    monkeypatch.setattr(ra, "has_source", lambda: True)
    monkeypatch.setattr(ra, "human_root", lambda: fake_root)
    out = tmp_path / "data"
    s = ra.FourRetrainAdapter(root=tmp_path).export_matches(out)
    assert s["source"] == "postgres (read only)" and s["kept"] == 3 and s["humanMatches"] == 2 and s["startPositions"] == 2
    assert (out / "matches.jsonl").exists() and (out / "holdout-starts.json").exists()


# --- the learn command ----------------------------------------------------------------------------------------------------------

def test_learn_needs_a_database_url_and_refuses_a_short_gate(tmp_path, monkeypatch, capsys):
    import argparse

    ap = argparse.ArgumentParser()
    learn.add_arguments(ap)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert learn.run_cli(ap.parse_args(["--game", "four", "--work-dir", str(tmp_path / "w")])) == 2
    assert not (tmp_path / "w").exists()
    monkeypatch.setenv("DATABASE_URL", "postgres://x")
    assert learn.run_cli(ap.parse_args(["--game", "chess", "--gate-games-per-seat", "50"])) == 2
    assert "400" in capsys.readouterr().err


def test_learn_human_share_default_is_under_the_cap_and_the_flag_is_checked():
    import argparse

    ap = argparse.ArgumentParser()
    learn.add_arguments(ap)
    assert ap.parse_args(["--game", "chess"]).human_share == learn.DEFAULT_HUMAN_SHARE <= MAX_HUMAN_SHARE
    with pytest.raises(ValueError):
        check_share(ap.parse_args(["--game", "chess", "--human-share", "0.4"]).human_share)


def test_learn_prints_pass_only_when_every_gate_passes_and_never_publishes(tmp_path, capsys):
    ok = [{"gate": "x", "passed": True, "reasons": []}, gates.seat_gate(seats(240, 235), name="seats")]
    r = learn.finish("four", tmp_path / "ok", ok, {}, print)
    assert r["passed"] and r["published"] is False
    assert "RESULT: PASS" in capsys.readouterr().out
    assert json.loads((tmp_path / "ok" / "result.json").read_text())["published"] is False
    bad = learn.no_result("four", tmp_path / "bad", "nothing to gate", {}, print)
    assert not bad["passed"]
    assert "RESULT: FAIL" in capsys.readouterr().out


def test_holdem_learn_builds_profiles_and_is_a_fail_with_no_candidate(tmp_path, monkeypatch, capsys):
    import argparse

    monkeypatch.setattr(learn, "build_profiles", lambda out: {"players": 4, "confidentPlayers": 1, "hands": 900, "optedOutMatches": 2})
    ap = argparse.ArgumentParser()
    learn.add_arguments(ap)
    r = learn.learn_holdem(tmp_path / "w", ap.parse_args(["--game", "holdem"]))
    assert not r["passed"] and r["profiles"]["players"] == 4
    assert "nothing to gate" in " ".join(r["reasons"])
    assert "RESULT: FAIL" in capsys.readouterr().out


def test_learn_does_not_touch_any_registry_or_adapter_flag():
    src = Path(learn.__file__).read_text()
    for forbidden in ("write_registry", "promote(", "add_version", "set_learns", "atomic_write_text"):
        assert forbidden not in src


# --- exporter wrapper -----------------------------------------------------------------------------------------------------------

def test_database_url_is_scrubbed_from_errors(tmp_path, monkeypatch):
    class P:
        returncode = 1
        stdout = ""
        stderr = "connect to postgres://user:pw@host/db failed"

    monkeypatch.setenv("DATABASE_URL", "postgres://user:pw@host/db")
    monkeypatch.setattr(human_export.subprocess, "run", lambda *a, **k: P())
    with pytest.raises(RuntimeError) as e:
        human_export._run(["bun", "x.ts"], tmp_path, 5)
    assert "pw" not in str(e.value) and "[database url]" in str(e.value)


def test_rehearsal_source_refuses_the_dev_database(tmp_path, monkeypatch):
    dev = human_export.PUBLIC / ".data" / "pglite"
    with pytest.raises(RuntimeError, match="dev database"):
        human_export.use_pglite(dev)
    with pytest.raises(RuntimeError, match="not a directory"):
        human_export.use_pglite(tmp_path / "missing")
    human_export.use_pglite(tmp_path)
    try:
        monkeypatch.delenv("DATABASE_URL", raising=False)
        human_export.require_database()  # a scratch database needs no URL
        assert human_export._source_args() == ["--pglite", str(tmp_path.resolve())]
    finally:
        human_export.use_pglite(None)


def test_export_refuses_without_a_database_url_and_app_root_can_be_set(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        human_export.export_human("four", tmp_path)
    (tmp_path / "apps" / "web" / "scripts").mkdir(parents=True)
    (tmp_path / human_export.EXPORT_SCRIPT).write_text("")
    monkeypatch.setenv(human_export.APP_ENV, str(tmp_path))
    assert human_export.app_root() == tmp_path
    monkeypatch.setenv(human_export.APP_ENV, str(tmp_path / "missing"))
    with pytest.raises(human_export.AppRootError):
        human_export.app_root()
