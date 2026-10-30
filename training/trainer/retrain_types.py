"""Plain types shared by trainer.retrain and the per-game retrain adapters."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Challenger:
    """What an adapter hands back after training: ONNX files per level it changed, their hashes and the provenance."""

    artifacts: dict[str, Path]
    sha256: dict[str, str]
    trained_steps: int
    human_matches_used: int
    notes: dict = field(default_factory=dict)
