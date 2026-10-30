"""Replay window of self-play positions, stored compactly (uint8 stones, float16 policy, int8 outcome)."""

from __future__ import annotations

import os
from collections import deque
from pathlib import Path

import numpy as np

from .board import mirror, replay_game, to_input


class ReplayBuffer:
    """Keeps the newest `window_games` finished games. Chunks are whole batches of games."""

    def __init__(self, window_games: int = 50_000):
        self.window_games = window_games
        self._chunks: deque[tuple[int, np.ndarray, np.ndarray, np.ndarray]] = deque()  # (games, planes, policy, z)
        self._games = 0
        self._flat: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None

    @property
    def games(self) -> int:
        return self._games

    @property
    def positions(self) -> int:
        return sum(len(c[3]) for c in self._chunks)

    def add_games(self, games: list[dict]) -> int:
        """Adds finished (not truncated) games; returns the number of positions added."""
        parts = [replay_game(g["moves"], g["visits"], g["winner"]) for g in games if not g.get("truncated") and g["moves"]]
        if not parts:
            return 0
        planes = np.concatenate([p[0] for p in parts])
        policy = np.concatenate([p[1] for p in parts]).astype(np.float16)
        z = np.concatenate([p[2] for p in parts]).astype(np.int8)
        self._chunks.append((len(parts), planes, policy, z))
        self._games += len(parts)
        while self._games > self.window_games and len(self._chunks) > 1:
            self._games -= self._chunks.popleft()[0]
        self._flat = None
        return len(z)

    def _arrays(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        if self._flat is None:
            self._flat = (
                np.concatenate([c[1] for c in self._chunks]),
                np.concatenate([c[2] for c in self._chunks]),
                np.concatenate([c[3] for c in self._chunks]),
            )
        return self._flat

    def sample(self, batch: int, rng: np.random.Generator, augment: bool = True) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """(inputs float32 (B, 3, 6, 7), policy float32 (B, 7), z float32 (B,)); half the rows mirrored when augmenting."""
        planes, policy, z = self._arrays()
        idx = rng.integers(0, len(z), size=batch)
        p, pi, zz = planes[idx], policy[idx].astype(np.float32), z[idx].astype(np.float32)
        if augment:
            flip = rng.random(batch) < 0.5
            if flip.any():
                p[flip], pi[flip] = mirror(p[flip], pi[flip])
        return to_input(p), pi, zz

    def save(self, path: Path | str) -> None:
        if not self._chunks:
            return
        path = Path(path)
        tmp = path.with_name(f".tmp-{os.getpid()}-{path.name}")
        planes, policy, z = self._arrays()
        sizes = np.array([c[0] for c in self._chunks], dtype=np.int64)
        lens = np.array([len(c[3]) for c in self._chunks], dtype=np.int64)
        with open(tmp, "wb") as f:
            np.savez(f, planes=planes, policy=policy, z=z, games=sizes, lens=lens)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

    @classmethod
    def load(cls, path: Path | str, window_games: int = 50_000) -> "ReplayBuffer":
        buf = cls(window_games)
        with np.load(path) as d:
            planes, policy, z, games, lens = d["planes"], d["policy"], d["z"], d["games"], d["lens"]
        off = 0
        for g, n in zip(games.tolist(), lens.tolist()):
            buf._chunks.append((g, planes[off : off + n], policy[off : off + n], z[off : off + n]))
            buf._games += g
            off += n
        return buf
