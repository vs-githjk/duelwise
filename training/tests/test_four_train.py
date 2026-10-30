import json
import math
import subprocess
import textwrap
from pathlib import Path
import numpy as np
import onnxruntime as ort
import pytest
import torch

from trainer.bridge import find_bun
from trainer.four.board import replay_game, to_input, mirror
from trainer.four.net import AZNet
from trainer.four.replay_buffer import ReplayBuffer
from trainer.four.train import FourTrainer, main


def test_two_iterations_of_eight_games_losses_finite_and_fixed_batch_drops(tmp_path):
    tr = FourTrainer(blocks=2, channels=16, window_games=100, seed=1)
    rows = [tr.iteration(games=8, parallel=8, sims=8, train_ratio=4, batch=32, seed=i + 1) for i in range(2)]
    assert [r["games"] for r in rows] == [8, 8]
    assert rows[1]["games_total"] == 16 and tr.buffer.games == 16
    for r in rows:
        assert r["steps"] >= 1 and math.isfinite(r["policy_loss"]) and math.isfinite(r["value_loss"])
    x, pi, z = tr.buffer.sample(64, np.random.default_rng(0), augment=False)
    before = tr.fixed_batch_loss(x, pi, z)
    tr.overfit(x, pi, z, 50)
    after = tr.fixed_batch_loss(x, pi, z)
    assert math.isfinite(before) and math.isfinite(after) and after < before

    # ONNX parity of the trained network, and the checkpoint resumes to the same weights.
    sha = tr.export(tmp_path / "m.onnx")
    assert len(sha) == 64
    sess = ort.InferenceSession(str(tmp_path / "m.onnx"), providers=["CPUExecutionProvider"])
    tr.model.eval()
    probe = torch.from_numpy(x[:5])
    got = sess.run(None, {"input": probe.numpy()})
    with torch.no_grad():
        logits, value = tr.model(probe)
    assert np.abs(got[0] - logits.numpy()).max() <= 1e-5 and np.abs(got[1] - value.numpy()).max() <= 1e-5

    tr.save(tmp_path / "ckpt")
    again = FourTrainer(blocks=2, channels=16, window_games=100, seed=9)
    assert again.resume(tmp_path / "ckpt") and again.games_total == 16 and again.buffer.games == 16
    assert again.buffer.positions == tr.buffer.positions
    again.model.eval()
    with torch.no_grad():
        assert torch.equal(again.model(probe)[0], logits)


def test_replay_game_planes_and_outcomes():
    # Seat 0 wins with four stacked in column 0 (seat 1 plays column 1).
    moves = [0, 1, 0, 1, 0, 1, 0]
    visits = [[1 if c == m else 0 for c in range(7)] for m in moves]
    planes, policy, z = replay_game(moves, visits, winner=0)
    assert planes.shape == (7, 2, 6, 7) and z.tolist() == [1, -1, 1, -1, 1, -1, 1]
    # Ply 1 (seat 1 to move): own = seat 1's stones (none yet), opponent = seat 0's stone at col 0 row 0.
    assert planes[1, 0].sum() == 0 and planes[1, 1][0, 0] == 1
    assert to_input(planes)[:, 2].min() == 1.0
    assert replay_game(moves[:2], visits[:2], None)[2].tolist() == [0, 0]
    with pytest.raises(ValueError):
        replay_game([0] * 7, [[0] * 7] * 7, None)
    m_planes, m_policy = mirror(planes, policy)
    assert m_planes[0].sum() == 0 and m_policy[0, 6] == 1 and m_planes[1, 1][0, 6] == 1


def test_replay_window_evicts_old_games_and_truncated_are_dropped():
    def game(n):
        return {"moves": [i % 7 for i in range(n)], "visits": [[1] * 7] * n, "winner": 0, "truncated": False}

    buf = ReplayBuffer(window_games=5)
    assert buf.add_games([{**game(3), "truncated": True}]) == 0
    for _ in range(3):
        buf.add_games([game(4)] * 2)
    assert buf.games == 4 and buf.positions == 16  # the oldest chunk of 2 games was evicted
    x, pi, z = buf.sample(10, np.random.default_rng(0))
    assert x.shape == (10, 3, 6, 7) and pi.shape == (10, 7) and z.shape == (10,)
    assert np.allclose(pi.sum(1), 1, atol=1e-3)


def test_train_entry_runs_checkpoints_and_resumes(tmp_path):
    args = ["--ckpt-dir", str(tmp_path / "ckpt"), "--run-dir", str(tmp_path), "--blocks", "2", "--channels", "16", "--games-per-iter", "4",
            "--parallel", "4", "--sims", "6", "--batch", "16", "--snapshot-every", "4", "--max-iterations", "2", "--threads", "1",
            "--export", str(tmp_path / "out.onnx")]
    assert main(args) == 0
    assert (tmp_path / "out.onnx").exists() and (tmp_path / "metrics.jsonl").exists()
    assert list((tmp_path / "snapshots").glob("snap-*.onnx")) and list((tmp_path / "snapshots").glob("snap-*.pt"))
    assert list((tmp_path / "ckpt").glob("ckpt-*.pt"))
    assert main(args[:-2] + ["--max-iterations", "3", "--resume"]) == 0
    lines = (tmp_path / "metrics.jsonl").read_text().strip().splitlines()
    assert len(lines) == 3 and '"iteration": 3' in lines[-1]


def test_python_features_equal_the_typescript_encoder():
    """The learner rebuilds positions from moves; they must be the planes the TS encoder gives the browser."""
    repo = Path(__file__).resolve().parents[2]
    moves = [3, 3, 2, 4, 2, 2, 4, 1, 5, 0, 6, 6, 3]
    script = textwrap.dedent(f"""
        import {{ fourCore, fourEncoder, fourFromMoves }} from {json.dumps(str(repo / "packages/core/src/games/four/index.ts"))}
        const moves = {json.dumps(moves)}
        const out: number[][] = []
        for (let i = 0; i < moves.length; i++) {{
          const s = fourFromMoves(moves.slice(0, i))
          const buf = new Float32Array(126)
          fourEncoder.encode(fourCore.observe(s, fourCore.toAct(s)[0]!), buf, 0)
          out.push(Array.from(buf))
        }}
        console.log(JSON.stringify(out))
    """)
    p = subprocess.run([find_bun(), "-e", script], capture_output=True, text=True, cwd=repo, timeout=60)
    assert p.returncode == 0, p.stderr
    ts = np.array(json.loads(p.stdout), dtype=np.float32).reshape(len(moves), 3, 6, 7)
    planes, _, _ = replay_game(moves, [[1] * 7] * len(moves), None)
    np.testing.assert_array_equal(to_input(planes), ts)
