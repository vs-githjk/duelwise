"""Chess value network: 768 sparse piece-square features -> 256 -> 32 -> 1 with clipped ReLU (clamp to 0..1) after
both hidden layers. `forward` returns the mover's expected score in 0..1 (sigmoid of the final affine); training
uses `logit` with binary cross-entropy against the soft target."""

from __future__ import annotations

import torch
from torch import nn

from .data import SPARSE_FEATURES


class ValueNet(nn.Module):
    def __init__(self, h1: int = 256, h2: int = 32):
        super().__init__()
        self.h1, self.h2 = h1, h2
        self.l1 = nn.Linear(SPARSE_FEATURES, h1)
        self.l2 = nn.Linear(h1, h2)
        self.l3 = nn.Linear(h2, 1)

    def logit(self, x: torch.Tensor) -> torch.Tensor:
        a = torch.clamp(self.l1(x), 0.0, 1.0)
        b = torch.clamp(self.l2(a), 0.0, 1.0)
        return self.l3(b).squeeze(1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.sigmoid(self.logit(x))

    def arch(self) -> list[int]:
        return [self.h1, self.h2]
