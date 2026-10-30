import json
import os
import struct
import subprocess
import textwrap
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pytest
import torch

from trainer.bridge import find_bun
from trainer.chess import export as chess_export
from trainer.chess.data import (MAX_ACTIVE, PAD_FEATURE, POLICY_RECORD_BYTES, REL_POLICY_SIZE, VALUE_RECORD_BYTES,
                                Shards, decode_policy, decode_value)
from trainer.chess.policy_net import PolicyNet, masked_logits, policy_loss
from trainer.chess.train_policy import main as policy_main
from trainer.chess.train_value import main as value_main
from trainer.chess.value_net import ValueNet
from trainer.jobs import load_spec

ROOT = Path(__file__).resolve().parents[2]


def _write_index(d: Path, kind: str, rb: int, files: list[tuple[str, int]]) -> None:
    (d / "index.json").write_text(json.dumps({
        "schema": 1, "kind": kind, "recordBytes": rb, "layout": [], "positions": sum(n for _, n in files),
        "shards": [{"file": f, "records": n} for f, n in files], "source": {}, "updatedAt": "x"}))


def synth_policy(d: Path, n: int = 600, per_shard: int = 400, seed: int = 0) -> None:
    """Records whose played move is a function of the piece on square 0 (13 classes), always legal, plus random other legal moves."""
    d.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    rec = np.zeros((n, POLICY_RECORD_BYTES), dtype=np.uint8)
    rec[:, :64] = rng.integers(0, 13, size=(n, 64))
    rec[:, 64] = rng.integers(0, 16, size=n)
    rec[:, 65] = 255
    rec[:, 66] = rng.integers(0, 120, size=n)
    rec[:, 67] = rng.integers(0, 3, size=n)
    moves = (rec[:, 0].astype(np.int64) * 37 + 5)
    rec[:, 68], rec[:, 69] = moves & 255, moves >> 8
    for i in range(n):
        legal = set(rng.integers(0, REL_POLICY_SIZE, size=20).tolist()) | {int(moves[i])}
        for m in legal:
            rec[i, 72 + (m >> 3)] |= 1 << (m & 7)
    files = []
    for s, lo in enumerate(range(0, n, per_shard)):
        part = rec[lo:lo + per_shard]
        part.tofile(d / f"shard-{s:05d}.bin")
        files.append((f"shard-{s:05d}.bin", len(part)))
    _write_index(d, "policy", POLICY_RECORD_BYTES, files)


def synth_value(d: Path, n: int = 1200, per_shard: int = 700, seed: int = 0) -> None:
    """Target is a fixed function of which of the first 8 features are on, so a small net can fit it."""
    d.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    rec = np.zeros((n, VALUE_RECORD_BYTES), dtype=np.uint8)
    feats = np.full((n, MAX_ACTIVE), PAD_FEATURE, dtype="<u2")
    target = np.zeros(n, dtype="<f4")
    for i in range(n):
        k = int(rng.integers(3, 20))
        f = np.sort(rng.choice(768, size=k, replace=False))
        feats[i, :k] = f
        target[i] = 0.1 + 0.8 * (np.sum(f < 384) / k)
    rec[:, :64] = feats.view(np.uint8).reshape(n, 64)
    rec[:, 64:68] = target.view(np.uint8).reshape(n, 4)
    files = []
    for s, lo in enumerate(range(0, n, per_shard)):
        rec[lo:lo + per_shard].tofile(d / f"shard-{s:05d}.bin")
        files.append((f"shard-{s:05d}.bin", len(rec[lo:lo + per_shard])))
    _write_index(d, "value", VALUE_RECORD_BYTES, files)


def test_policy_fifty_steps_lower_loss_and_mask_zeroes_illegal(tmp_path):
    synth_policy(tmp_path / "b")
    sh = Shards(tmp_path / "b", "policy")
    assert sh.n == 600 and sh.val_n == 30 and sh.train_n == 570
    torch.manual_seed(0)
    net = PolicyNet(blocks=2, channels=16)
    opt = torch.optim.Adam(net.parameters(), lr=2e-3)
    rng = np.random.default_rng(1)
    probe = decode_policy(sh.take(np.arange(64)))
    net.eval()
    with torch.no_grad():
        before = policy_loss(net(probe["planes"]), probe["mask"], probe["move"]).item()
    net.train()
    for _ in range(50):
        b = decode_policy(sh.sample(rng, 64))
        loss = policy_loss(net(b["planes"]), b["mask"], b["move"])
        opt.zero_grad()
        loss.backward()
        opt.step()
    net.eval()
    with torch.no_grad():
        logits = net(probe["planes"])
        after = policy_loss(logits, probe["mask"], probe["move"]).item()
        probs = torch.softmax(masked_logits(logits, probe["mask"]), dim=1)
    assert after < before - 0.5, (before, after)
    assert probs[~probe["mask"]].max().item() == 0.0
    assert torch.allclose(probs.sum(1), torch.ones(64), atol=1e-5)


def test_value_fifty_steps_lower_loss(tmp_path):
    synth_value(tmp_path / "v")
    sh = Shards(tmp_path / "v", "value")
    torch.manual_seed(0)
    net = ValueNet(32, 8)
    opt = torch.optim.Adam(net.parameters(), lr=3e-3)
    x, t = decode_value(sh.take(np.arange(256)))
    assert x.shape == (256, 768) and x.sum(1).max() <= MAX_ACTIVE and 0 <= t.min() and t.max() <= 1
    first = None
    for _ in range(50):
        loss = torch.nn.functional.binary_cross_entropy_with_logits(net.logit(x), t)
        first = first if first is not None else loss.item()
        opt.zero_grad()
        loss.backward()
        opt.step()
    assert loss.item() < first - 0.01


def test_onnx_parity_policy_and_value_and_value_bin_roundtrip(tmp_path):
    synth_policy(tmp_path / "b", n=64)
    synth_value(tmp_path / "v", n=64)
    torch.manual_seed(2)
    pn = PolicyNet(blocks=2, channels=16).eval()
    sha = chess_export.export_policy(pn, tmp_path / "policy.onnx")
    assert len(sha) == 64
    x = decode_policy(Shards(tmp_path / "b", "policy").take(np.arange(7)))["planes"]
    got = ort.InferenceSession(str(tmp_path / "policy.onnx"), providers=["CPUExecutionProvider"]).run(None, {"input": x.numpy()})[0]
    with torch.no_grad():
        assert np.abs(got - pn(x).numpy()).max() <= 1e-4
    assert got.shape == (7, REL_POLICY_SIZE)

    vn = ValueNet(64, 8).eval()
    with torch.no_grad():  # make the biases non-trivial so the round trip checks them too
        for p in vn.parameters():
            p.add_(torch.randn_like(p) * 0.3)
    chess_export.export_value(vn, tmp_path / "value.onnx", tmp_path / "value.bin")
    xv, _ = decode_value(Shards(tmp_path / "v", "value").take(np.arange(40)))
    gotv = ort.InferenceSession(str(tmp_path / "value.onnx"), providers=["CPUExecutionProvider"]).run(None, {"input": xv.numpy()})[0]
    with torch.no_grad():
        want = vn(xv).numpy()
    assert np.abs(gotv - want).max() <= 1e-5
    w = chess_export.read_value_bin(tmp_path / "value.bin")
    assert (w["n_in"], w["h1"], w["h2"], w["n_out"]) == (768, 64, 8, 1)
    # Same arithmetic the TS evaluator does: sparse row sums, clipped ReLU, sigmoid.
    for row in range(40):
        active = np.nonzero(xv[row].numpy())[0]
        assert np.abs(chess_export.value_bin_forward(w, active) - want[row]) <= 1e-5
    raw = (tmp_path / "value.bin").read_bytes()
    assert raw[:4] == b"CHV1" and len(raw) == 4 + 16 + 4 * (768 * 64 + 64 + 8 * 64 + 8 + 8 + 1)


def test_python_planes_equal_typescript_encoder(tmp_path):
    """The TS side writes policy records and the encodeRel planes for the same FENs; the Python decoder must reproduce them."""
    script = tmp_path / "gen.ts"
    core = ROOT / "packages" / "core" / "src" / "games" / "chess"
    script.write_text(textwrap.dedent(f"""
        import {{ writeFileSync }} from 'node:fs'
        import {{ Chess }} from {json.dumps(str(ROOT / 'node_modules' / 'chess.js'))}
        import {{ policyRecord }} from {json.dumps(str(core / 'shards.ts'))}
        import {{ encodeRel, PLANES }} from {json.dumps(str(core / 'encode.ts'))}
        import {{ parsePosition, toPerspective }} from {json.dumps(str(core / 'position.ts'))}
        const fens = [
          'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 2',
          'r3k2r/pppq1ppp/2n2n2/3pp3/3PP3/2N2N2/PPPQ1PPP/R3K2R w KQkq d6 13 9',
          '4k3/8/8/3pP3/8/8/8/4K3 w - d6 40 60',
          'r3k2r/8/8/8/8/8/8/R3K2R b Kq - 99 70',
        ]
        const recs: number[][] = []
        const planes = new Float32Array(fens.length * PLANES * 64)
        fens.forEach((fen, i) => {{
          const c = new Chess(fen)
          const legal = c.moves({{ verbose: true }}).map((m) => m.from + m.to + (m.promotion ?? ''))
          recs.push(Array.from(policyRecord(fen, legal[0]!, legal, 1, i)))
          encodeRel(toPerspective(parsePosition(fen)), planes, i * PLANES * 64)
        }})
        writeFileSync(process.argv[2]!, JSON.stringify({{ recs, planes: Array.from(planes) }}))
    """))
    out = tmp_path / "out.json"
    r = subprocess.run([find_bun(), "run", str(script), str(out)], capture_output=True, text=True, cwd=str(ROOT), timeout=120)
    assert r.returncode == 0, r.stderr
    data = json.loads(out.read_text())
    rec = np.array(data["recs"], dtype=np.uint8)
    got = decode_policy(rec)
    want = torch.tensor(data["planes"], dtype=torch.float32).reshape(len(rec), 18, 8, 8)
    assert torch.equal(got["planes"], want)
    assert (got["mask"].sum(1) >= 1).all() and got["mask"][torch.arange(len(rec)), got["move"]].all()


def test_policy_and_value_mains_checkpoint_resume_and_export(tmp_path, monkeypatch):
    synth_policy(tmp_path / "data" / "b1100")
    synth_value(tmp_path / "data" / "value")
    run = tmp_path / "run"
    args = ["--data-dir", str(tmp_path / "data"), "--run-dir", str(run), "--blocks", "2", "--channels", "16", "--batch", "32",
            "--device", "cpu", "--buckets", "b1100", "--max-steps", "12"]
    assert policy_main(args) == 0
    ck = run / "ckpt" / "b1100"
    assert sorted(p.name for p in ck.glob("ckpt-*.pt")) == ["ckpt-0000000012.pt"]
    assert (run / "export" / "b1100" / "policy.onnx").exists()
    # Resume continues from step 12 and a finished bucket does not train again.
    assert policy_main(args + ["--resume", "--max-steps", "20"]) == 0
    assert sorted(p.name for p in ck.glob("ckpt-*.pt"))[-1] == "ckpt-0000000020.pt"
    assert policy_main(args + ["--resume", "--max-steps", "20"]) == 0
    assert sorted(p.name for p in ck.glob("ckpt-*.pt"))[-1] == "ckpt-0000000020.pt"

    vrun = tmp_path / "vrun"
    vargs = ["--data-dir", str(tmp_path / "data"), "--run-dir", str(vrun), "--h1", "16", "--h2", "8", "--batch", "64",
             "--max-steps", "15"]
    assert value_main(vargs) == 0
    assert (vrun / "export" / "value.onnx").exists() and (vrun / "export" / "value.bin").exists()
    rows = [json.loads(l) for l in (vrun / "metrics.jsonl").read_text().splitlines()]
    assert rows and rows[-1]["step"] == 15 and np.isfinite(rows[-1]["val_mse"])


@pytest.mark.parametrize("name,slots,mps", [("chess-value", 1, False), ("chess-policy", 0, True)])
def test_job_specs_wait_for_chess_data(name, slots, mps):
    spec = load_spec(name, ROOT / "training" / "jobs")
    assert spec.after == ["chess-data"] and spec.cpu_slots == slots and spec.mps is mps
    assert spec.cmd[:3] == ["scripts/py", "-m", f"trainer.chess.train_{name.split('-')[1]}"]
    assert spec.checkpoint_dir == f"runs/{name}/ckpt"
