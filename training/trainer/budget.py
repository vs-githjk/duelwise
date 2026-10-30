"""Compute budget shared by every lane: CPU slots, MPS jobs, nice level (training/budget.json)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .paths import TRAINING_DIR

DEFAULT_PATH = TRAINING_DIR / "budget.json"


@dataclass(frozen=True)
class Budget:
    cpu_slots: int
    mps_jobs: int
    nice: int

    def as_json(self) -> dict:
        return {"cpuSlots": self.cpu_slots, "mpsJobs": self.mps_jobs, "nice": self.nice}


def load_budget(path: Path | str = DEFAULT_PATH) -> Budget:
    d = json.loads(Path(path).read_text())
    b = Budget(cpu_slots=int(d["cpuSlots"]), mps_jobs=int(d["mpsJobs"]), nice=int(d["nice"]))
    if b.cpu_slots < 0 or b.mps_jobs < 0 or not 0 <= b.nice <= 19:
        raise ValueError(f"invalid budget in {path}: {d}")
    return b
