import os
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest
import torch

from trainer.checkpoint import load_latest, save_checkpoint

TRAINING = Path(__file__).resolve().parents[1]


def make(seed=0):
    torch.manual_seed(seed)
    model = torch.nn.Sequential(torch.nn.Linear(4, 8), torch.nn.Tanh(), torch.nn.Linear(8, 2))
    opt = torch.optim.Adam(model.parameters(), lr=1e-2)
    return model, opt


def train_steps(model, opt, n, start=0):
    for i in range(start, start + n):
        g = torch.Generator().manual_seed(1000 + i)
        x = torch.randn(16, 4, generator=g)
        loss = (model(x) ** 2).mean()
        opt.zero_grad()
        loss.backward()
        opt.step()


def same(m1, m2):
    return all(torch.equal(a, b) for a, b in zip(m1.state_dict().values(), m2.state_dict().values()))


def test_empty_dir_gives_none(tmp_path):
    assert load_latest(tmp_path / "nope") is None


def test_resume_restores_step_model_and_optimiser(tmp_path):
    ref_model, ref_opt = make()
    train_steps(ref_model, ref_opt, 10)

    model, opt = make()
    train_steps(model, opt, 5)
    save_checkpoint(tmp_path, 5, model, opt, extra={"note": "hi"})

    model2, opt2 = make(seed=99)  # different init, must be overwritten
    info = load_latest(tmp_path, model2, opt2)
    assert info["step"] == 5 and info["extra"] == {"note": "hi"}
    assert same(model, model2)
    train_steps(model2, opt2, 5, start=5)
    assert same(ref_model, model2)  # optimiser moments came back, so the run matches an uninterrupted one


def test_latest_wins_and_corrupt_newest_falls_back(tmp_path):
    model, opt = make()
    save_checkpoint(tmp_path, 10, model, opt)
    train_steps(model, opt, 3)
    p20 = save_checkpoint(tmp_path, 20, model, opt)
    assert load_latest(tmp_path)["step"] == 20
    p20.write_bytes(p20.read_bytes()[:50])  # truncated file
    assert load_latest(tmp_path)["step"] == 10


def test_atomic_write_survives_kill_mid_write(tmp_path):
    ckpt = tmp_path / "ckpt"
    script = textwrap.dedent(
        f"""
        import os, sys, time, torch
        from trainer import checkpoint
        torch.manual_seed(0)
        model = torch.nn.Linear(4, 4)
        checkpoint.save_checkpoint({str(ckpt)!r}, 1, model)
        with torch.no_grad():
            model.weight.add_(1.0)
        real_fsync = os.fsync
        def stuck_fsync(fd):
            real_fsync(fd)
            print("MIDWRITE", flush=True)
            time.sleep(600)
        os.fsync = stuck_fsync
        checkpoint.save_checkpoint({str(ckpt)!r}, 2, model)
        """
    )
    env = {**os.environ, "PYTHONPATH": str(TRAINING)}
    p = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE, env=env, text=True)
    try:
        assert p.stdout.readline().strip() == "MIDWRITE"
        os.kill(p.pid, signal.SIGKILL)
    finally:
        p.kill()
        p.wait()
    names = sorted(x.name for x in ckpt.iterdir())
    assert any(n.startswith(".tmp-") for n in names), names  # the half-finished write is still around
    assert [n for n in names if n.startswith("ckpt-")] == ["ckpt-0000000001.pt"]
    torch.manual_seed(0)
    fresh = torch.nn.Linear(4, 4)
    info = load_latest(ckpt, fresh)
    assert info["step"] == 1
    torch.manual_seed(0)
    assert torch.equal(fresh.weight, torch.nn.Linear(4, 4).weight)


def test_keep_last_prunes_only_older_checkpoints(tmp_path):
    model, opt = make()
    for s in (1, 2, 3, 4):
        save_checkpoint(tmp_path, s, model, opt, keep_last=2)
    assert sorted(p.name for p in tmp_path.glob("ckpt-*.pt")) == ["ckpt-0000000003.pt", "ckpt-0000000004.pt"]


def test_mismatch_raises_naming_file_and_key(tmp_path):
    from trainer.checkpoint import CheckpointMismatch

    save_checkpoint(tmp_path, 500, torch.nn.Linear(8, 1))
    with pytest.raises(CheckpointMismatch) as e:
        load_latest(tmp_path, torch.nn.Linear(16, 1))
    assert "ckpt-0000000500.pt" in str(e.value)
    assert "weight" in str(e.value)


def test_key_mismatch_raises(tmp_path):
    from trainer.checkpoint import CheckpointMismatch

    save_checkpoint(tmp_path, 1, torch.nn.Linear(4, 2))
    with pytest.raises(CheckpointMismatch):
        load_latest(tmp_path, torch.nn.Sequential(torch.nn.Linear(4, 2)))


def test_corrupt_newest_skipped_and_logged(tmp_path, caplog):
    m = torch.nn.Linear(4, 2)
    save_checkpoint(tmp_path, 1, m)
    (tmp_path / "ckpt-0000000002.pt").write_bytes(b"truncated garbage")
    with caplog.at_level("WARNING"):
        got = load_latest(tmp_path, torch.nn.Linear(4, 2))
    assert got["step"] == 1
    assert "ckpt-0000000002.pt" in caplog.text


def test_keep_last_never_deletes_higher_steps(tmp_path):
    m = torch.nn.Linear(4, 2)
    for s in (100, 200, 900):
        save_checkpoint(tmp_path, s, m)
    save_checkpoint(tmp_path, 300, m, keep_last=1)
    names = sorted(p.name for p in tmp_path.glob("ckpt-*.pt"))
    assert "ckpt-0000000900.pt" in names
    assert "ckpt-0000000300.pt" in names
    assert "ckpt-0000000100.pt" not in names
