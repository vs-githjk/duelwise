"""Chess policy network: ResNet (6 blocks x 64 channels) on the 18 mover-side planes (encode.ts), one logit per
relative policy index (4168). Illegal moves are masked by the caller: the net itself outputs raw logits, so the
browser agent masks with its own legal-move list and the ONNX file needs only the planes as input."""

from __future__ import annotations

import torch
import torch.nn.functional as F
from torch import nn

from .data import PLANES, REL_POLICY_SIZE

MASK_VALUE = -1e9


class ResBlock(nn.Module):
    def __init__(self, ch: int):
        super().__init__()
        self.c1 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(ch)
        self.c2 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(ch)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = F.relu(self.b1(self.c1(x)))
        y = self.b2(self.c2(y))
        return F.relu(x + y)


class PolicyNet(nn.Module):
    """Input (N, 18, 8, 8) -> logits (N, 4168). The head squeezes to 8 channels before the linear layer so one
    exported net stays near 10 MB (the repo limit for a committed model is 20 MB)."""

    def __init__(self, blocks: int = 6, channels: int = 64, head_channels: int = 8):
        super().__init__()
        self.blocks, self.channels, self.head_channels = blocks, channels, head_channels
        self.stem = nn.Sequential(nn.Conv2d(PLANES, channels, 3, padding=1, bias=False), nn.BatchNorm2d(channels), nn.ReLU())
        self.tower = nn.Sequential(*[ResBlock(channels) for _ in range(blocks)])
        self.head = nn.Sequential(
            nn.Conv2d(channels, head_channels, 1, bias=False), nn.BatchNorm2d(head_channels), nn.ReLU(), nn.Flatten(),
            nn.Linear(head_channels * 64, REL_POLICY_SIZE),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.tower(self.stem(x)))

    def arch(self) -> list[int]:
        return [self.blocks, self.channels, self.head_channels]


def masked_logits(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """Logits with every illegal move pushed to -1e9, so softmax gives it probability exactly 0."""
    return logits.masked_fill(~mask, MASK_VALUE)


def policy_loss(logits: torch.Tensor, mask: torch.Tensor, move: torch.Tensor) -> torch.Tensor:
    return F.cross_entropy(masked_logits(logits, mask), move)


def top1_accuracy(logits: torch.Tensor, mask: torch.Tensor, move: torch.Tensor) -> float:
    return (masked_logits(logits, mask).argmax(dim=1) == move).float().mean().item()
