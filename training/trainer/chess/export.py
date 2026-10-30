"""Exports of the chess networks.

Policy: `policy.onnx`, input (N, 18, 8, 8) planes, output logits (N, 4168); the caller masks illegal moves.
Value: `value.onnx` (input (N, 768) multi-hot, output (N,) expected score in 0..1) and `value.bin`, the raw weights
for the TypeScript evaluator.

value.bin, little endian:
    bytes 0..3    magic "CHV1"
    bytes 4..19   u32 n_in (768), h1, h2, n_out (1)
    then float32 arrays in this order:
      w1  [n_in][h1]   row f holds the weights of feature f, so a sparse input is a sum of rows
      b1  [h1]
      w2  [h2][h1]     row j holds the weights into hidden unit j
      b2  [h2]
      w3  [n_out][h2]
      b3  [n_out]
Evaluation: a1 = clamp(b1 + sum of w1 rows of the active features, 0, 1); a2 = clamp(b2 + w2 a1, 0, 1);
score = sigmoid(b3 + w3 a2), the mover's expected score."""

from __future__ import annotations

import argparse
import struct
from pathlib import Path

import numpy as np
import torch

from ..checkpoint import load_latest
from ..export_onnx import export_onnx
from ..paths import atomic_write_bytes
from .data import PLANES, SPARSE_FEATURES
from .policy_net import PolicyNet
from .value_net import ValueNet

MAGIC = b"CHV1"


def export_policy(model: PolicyNet, path: Path | str) -> str:
    return export_onnx(model.cpu(), torch.zeros(2, PLANES, 8, 8), path)


def write_value_bin(model: ValueNet, path: Path | str) -> None:
    sd = {k: v.detach().cpu().float().numpy() for k, v in model.state_dict().items()}
    parts = [MAGIC, struct.pack("<4I", SPARSE_FEATURES, model.h1, model.h2, 1)]
    for a in (sd["l1.weight"].T, sd["l1.bias"], sd["l2.weight"], sd["l2.bias"], sd["l3.weight"], sd["l3.bias"]):
        parts.append(np.ascontiguousarray(a, dtype="<f4").tobytes())
    atomic_write_bytes(path, b"".join(parts))


def read_value_bin(path: Path | str) -> dict:
    raw = Path(path).read_bytes()
    if raw[:4] != MAGIC:
        raise ValueError(f"{path}: not a value.bin (magic {raw[:4]!r})")
    n_in, h1, h2, n_out = struct.unpack("<4I", raw[4:20])
    shapes = [("w1", (n_in, h1)), ("b1", (h1,)), ("w2", (h2, h1)), ("b2", (h2,)), ("w3", (n_out, h2)), ("b3", (n_out,))]
    out: dict = {"n_in": n_in, "h1": h1, "h2": h2, "n_out": n_out}
    pos = 20
    for name, shape in shapes:
        n = int(np.prod(shape))
        out[name] = np.frombuffer(raw, dtype="<f4", count=n, offset=pos).reshape(shape)
        pos += 4 * n
    if pos != len(raw):
        raise ValueError(f"{path}: {len(raw) - pos} trailing bytes")
    return out


def value_bin_forward(w: dict, active: np.ndarray) -> float:
    """Reference evaluation from value.bin and the active feature indices (what the TS evaluator does)."""
    a1 = np.clip(w["b1"] + w["w1"][np.asarray(active, dtype=np.int64)].sum(axis=0), 0.0, 1.0)
    a2 = np.clip(w["b2"] + w["w2"] @ a1, 0.0, 1.0)
    z = float((w["b3"] + w["w3"] @ a2)[0])
    return 1.0 / (1.0 + float(np.exp(-z)))


def export_value(model: ValueNet, onnx_path: Path | str, bin_path: Path | str) -> str:
    sha = export_onnx(model.cpu(), torch.zeros(2, SPARSE_FEATURES), onnx_path)
    write_value_bin(model, bin_path)
    return sha


def load_policy(ckpt_dir: Path | str) -> PolicyNet | None:
    ck = _arch(ckpt_dir)
    if ck is None:
        return None
    net = PolicyNet(*ck)
    return net if load_latest(ckpt_dir, net) else None


def load_value(ckpt_dir: Path | str) -> ValueNet | None:
    ck = _arch(ckpt_dir)
    if ck is None:
        return None
    net = ValueNet(*ck)
    return net if load_latest(ckpt_dir, net) else None


def _arch(ckpt_dir: Path | str) -> list[int] | None:
    files = sorted(Path(ckpt_dir).glob("ckpt-*.pt")) if Path(ckpt_dir).is_dir() else []
    for p in reversed(files):
        try:
            return list(torch.load(p, map_location="cpu", weights_only=False)["extra"]["arch"])
        except Exception:
            continue
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="export a trained chess net from its checkpoint directory")
    ap.add_argument("kind", choices=["policy", "value"])
    ap.add_argument("--ckpt-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    a = ap.parse_args(argv)
    out = Path(a.out_dir)
    if a.kind == "policy":
        net = load_policy(a.ckpt_dir)
        if net is None:
            print("no checkpoint", flush=True)
            return 1
        print("sha256", export_policy(net, out / "policy.onnx"))
    else:
        net = load_value(a.ckpt_dir)
        if net is None:
            print("no checkpoint", flush=True)
            return 1
        print("sha256", export_value(net, out / "value.onnx", out / "value.bin"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
