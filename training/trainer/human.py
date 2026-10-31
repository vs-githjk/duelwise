"""Human game data in a training mix: the 30 percent cap and weighted sampling (decisions.md, 2026-10-30: human share at most 30 percent).

The export (apps/web/scripts/export-human.ts) gives every kept match a weight; the chess shard builder writes one weight per record
(weights.bin). `MixedSampler` draws a batch that is at most MAX_HUMAN_SHARE human records, human records picked in proportion to their weight."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .chess.data import POLICY_RECORD_BYTES, Shards

MAX_HUMAN_SHARE = 0.30
#: A human record is shown at most this many times over a whole run; with few human records the share shrinks instead of repeating them.
MAX_HUMAN_REPEATS = 3.0


def check_share(share: float) -> float:
    if not 0.0 <= share <= MAX_HUMAN_SHARE:
        raise ValueError(f"human share {share} is outside [0, {MAX_HUMAN_SHARE}]: the locked cap is {MAX_HUMAN_SHARE:.0%}")
    return share


def effective_human_share(requested: float, n_human: int, total_samples: int, max_repeats: float = MAX_HUMAN_REPEATS) -> float:
    """The share actually used: never above the cap, and never so high that a human record would be seen more than `max_repeats` times."""
    check_share(requested)
    if n_human <= 0 or total_samples <= 0:
        return 0.0
    return min(requested, max_repeats * n_human / total_samples)


class HumanShards:
    """Weighted policy records of the human's own moves: <dir>/shard-*.bin + index.json + weights.bin (float32, one per record)."""

    def __init__(self, directory: Path | str):
        self.dir = Path(directory)
        self.shards = Shards(self.dir, "policy")
        self.n = self.shards.n
        w = np.fromfile(self.dir / "weights.bin", dtype="<f4")
        if len(w) != self.n:
            raise ValueError(f"{self.dir}: {len(w)} weights for {self.n} records")
        if (w < 0).any() or not np.isfinite(w).all():
            raise ValueError(f"{self.dir}: weights must be finite and not negative")
        self.weights = w.astype(np.float64)
        if self.weights.sum() <= 0:
            raise ValueError(f"{self.dir}: every weight is 0")
        self.p = self.weights / self.weights.sum()

    def sample(self, rng: np.random.Generator, batch: int) -> np.ndarray:
        idx = np.sort(rng.choice(self.n, size=batch, replace=True, p=self.p))
        return self.shards.take(idx)


class MixedSampler:
    """Batches of Lichess records with at most `share` of them from human games."""

    def __init__(self, base: Shards, human: HumanShards | None, share: float, rng: np.random.Generator, total_samples: int):
        self.base, self.human, self.rng = base, human, rng
        self.share = effective_human_share(share, human.n if human else 0, total_samples)

    def sample(self, batch: int) -> np.ndarray:
        n_h = int(round(batch * self.share)) if self.human else 0
        n_h = min(n_h, int(batch * 0.30))  # rounding can never push a batch past the cap
        parts = [self.base.sample(self.rng, batch - n_h)]
        if n_h:
            parts.append(self.human.sample(self.rng, n_h))
        out = np.concatenate(parts)
        assert out.shape == (batch, POLICY_RECORD_BYTES)
        return out
