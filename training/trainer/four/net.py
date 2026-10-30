"""AlphaZero-lite network for Four in a Row: 5 residual blocks x 64 channels, policy logits and a tanh value.

Input (N, 3, 6, 7), the same planes as packages/core/src/games/four/encode.ts. Outputs (logits (N, 7), value (N,))
from the view of the seat to act."""

from __future__ import annotations

import torch
from torch import nn

from .board import COLS, PLANES, ROWS


class ResBlock(nn.Module):
    def __init__(self, ch: int):
        super().__init__()
        self.c1 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(ch)
        self.c2 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(ch)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = torch.relu(self.b1(self.c1(x)))
        y = self.b2(self.c2(y))
        return torch.relu(x + y)


class AZNet(nn.Module):
    def __init__(self, blocks: int = 5, channels: int = 64):
        super().__init__()
        self.blocks, self.channels = blocks, channels
        self.stem = nn.Sequential(nn.Conv2d(PLANES, channels, 3, padding=1, bias=False), nn.BatchNorm2d(channels), nn.ReLU())
        self.tower = nn.Sequential(*[ResBlock(channels) for _ in range(blocks)])
        self.policy = nn.Sequential(nn.Conv2d(channels, 2, 1, bias=False), nn.BatchNorm2d(2), nn.ReLU(), nn.Flatten(), nn.Linear(2 * ROWS * COLS, COLS))
        self.value = nn.Sequential(
            nn.Conv2d(channels, 1, 1, bias=False), nn.BatchNorm2d(1), nn.ReLU(), nn.Flatten(),
            nn.Linear(ROWS * COLS, 64), nn.ReLU(), nn.Linear(64, 1), nn.Tanh(),
        )

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        h = self.tower(self.stem(x))
        return self.policy(h), self.value(h).squeeze(1)
