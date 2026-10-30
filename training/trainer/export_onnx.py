"""ONNX export with an onnxruntime parity check."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

PARITY_TOLERANCE = 1e-5


class ParityError(RuntimeError):
    pass


def _as_tuple(out) -> tuple[torch.Tensor, ...]:
    return tuple(out) if isinstance(out, (tuple, list)) else (out,)


def export_onnx(model: torch.nn.Module, sample: torch.Tensor, path: Path | str, opset: int = 17) -> str:
    """Export `model` for inputs shaped like `sample` (batch axis dynamic), check that onnxruntime
    reproduces the torch outputs within PARITY_TOLERANCE on the sample and on a different batch
    size, then return the sha256 of the file. A failed check raises ParityError and leaves no file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".tmp-{os.getpid()}-{path.name}")
    was_training = model.training
    model.eval()
    try:
        with torch.no_grad():
            n_out = len(_as_tuple(model(sample)))
        out_names = [f"out{i}" for i in range(n_out)]
        torch.onnx.export(
            model,
            (sample,),
            str(tmp),
            input_names=["input"],
            output_names=out_names,
            dynamic_axes={"input": {0: "batch"}, **{n: {0: "batch"} for n in out_names}},
            opset_version=opset,
            dynamo=False,
        )
        sess = ort.InferenceSession(str(tmp), providers=["CPUExecutionProvider"])
        worst = 0.0
        for x in (sample, torch.cat([sample, sample[:1]], dim=0)):
            with torch.no_grad():
                want = _as_tuple(model(x))
            got = sess.run(None, {"input": x.detach().cpu().numpy()})
            for w, g in zip(want, got):
                worst = max(worst, float(np.abs(w.detach().cpu().numpy() - g).max()))
        if not worst <= PARITY_TOLERANCE:
            raise ParityError(f"onnxruntime differs from torch by {worst:.3g} (limit {PARITY_TOLERANCE:g})")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
        model.train(was_training)
    return hashlib.sha256(path.read_bytes()).hexdigest()
