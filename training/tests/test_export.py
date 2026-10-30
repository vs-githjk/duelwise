import hashlib

import numpy as np
import onnxruntime as ort
import pytest
import torch

from trainer.export_onnx import ParityError, export_onnx


def ort_run(path, x):
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return sess.run(None, {sess.get_inputs()[0].name: x})


def test_mlp_matches_onnxruntime_and_returns_sha(tmp_path):
    torch.manual_seed(0)
    model = torch.nn.Sequential(torch.nn.Linear(10, 32), torch.nn.ReLU(), torch.nn.Linear(32, 5))
    sample = torch.randn(3, 10)
    path = tmp_path / "mlp.onnx"
    sha = export_onnx(model, sample, path)
    assert sha == hashlib.sha256(path.read_bytes()).hexdigest()
    x = torch.randn(7, 10)  # a different batch size than the sample: the batch axis is dynamic
    with torch.no_grad():
        want = model(x).numpy()
    got = ort_run(path, x.numpy())[0]
    assert np.abs(got - want).max() <= 1e-5


def test_conv_net_with_two_heads_matches(tmp_path):
    class Net(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.conv = torch.nn.Sequential(torch.nn.Conv2d(2, 4, 3, padding=1), torch.nn.ReLU(), torch.nn.Conv2d(4, 4, 3, padding=1), torch.nn.ReLU())
            self.policy = torch.nn.Linear(4 * 6 * 7, 7)
            self.value = torch.nn.Linear(4 * 6 * 7, 1)

        def forward(self, x):
            h = self.conv(x).flatten(1)
            return self.policy(h), torch.tanh(self.value(h))

    torch.manual_seed(1)
    model = Net()
    sample = torch.randn(2, 2, 6, 7)
    path = tmp_path / "conv.onnx"
    export_onnx(model, sample, path)
    x = torch.randn(5, 2, 6, 7)
    with torch.no_grad():
        p, v = model(x)
    gp, gv = ort_run(path, x.numpy())
    assert np.abs(gp - p.numpy()).max() <= 1e-5
    assert np.abs(gv - v.numpy()).max() <= 1e-5


def test_parity_failure_raises_and_removes_the_file(tmp_path, monkeypatch):
    model = torch.nn.Linear(3, 2)
    import trainer.export_onnx as mod

    monkeypatch.setattr(mod, "PARITY_TOLERANCE", -1.0)  # nothing can pass
    path = tmp_path / "bad.onnx"
    with pytest.raises(ParityError):
        export_onnx(model, torch.randn(2, 3), path)
    assert not path.exists()


def test_export_leaves_model_mode_alone(tmp_path):
    model = torch.nn.Sequential(torch.nn.Linear(3, 3), torch.nn.Dropout(0.5))
    model.train()
    export_onnx(model, torch.randn(2, 3), tmp_path / "m.onnx")
    assert model.training
