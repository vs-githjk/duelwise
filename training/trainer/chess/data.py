"""Chess training data: memmapped shards written by the Lichess pipeline (packages/core/src/games/chess/shards.ts)
and the decoders that turn raw records into network inputs.

Shards live in <common root>/data/cache/chess/{b1100,b1500,b1900,value}/ with an index.json (record size, shard list).
Records are fixed size, little endian, from the mover's side. Record layouts are documented in data/README.md; the
policy plane layout is the one in packages/core/src/games/chess/encode.ts (tested against it in test_chess_train.py).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch

from ..paths import common_root

POLICY_RECORD_BYTES = 600
VALUE_RECORD_BYTES = 68
REL_POLICY_SIZE = 4096 + 72
PLANES = 18
SPARSE_FEATURES = 768
MAX_ACTIVE = 32
PAD_FEATURE = 0xFFFF
HOLDOUT_MAX = 20_000

_SHIFTS4 = torch.arange(4)
_SHIFTS8 = torch.arange(8)
_MASK_BYTES = (REL_POLICY_SIZE + 7) // 8


def chess_cache_dir() -> Path:
    return common_root() / "data" / "cache" / "chess"


class Shards:
    """Random access over every record of a shard directory. The last `val_n` records are held out for validation."""

    def __init__(self, directory: Path | str, kind: str):
        self.dir = Path(directory)
        want = POLICY_RECORD_BYTES if kind == "policy" else VALUE_RECORD_BYTES
        index = json.loads((self.dir / "index.json").read_text())
        if index.get("kind") != kind or index.get("recordBytes") != want:
            raise ValueError(f"{self.dir}: expected a {kind} index with {want}-byte records, got {index.get('kind')} / {index.get('recordBytes')}")
        self.record_bytes = want
        self.arrays: list[np.ndarray] = []
        for s in index["shards"]:
            path = self.dir / s["file"]
            if not path.exists():
                continue
            n = min(s["records"], path.stat().st_size // want)
            if n > 0:
                self.arrays.append(np.memmap(path, dtype=np.uint8, mode="r", shape=(n, want)))
        sizes = [len(a) for a in self.arrays]
        self.starts = np.concatenate([[0], np.cumsum(sizes)]).astype(np.int64)
        self.n = int(self.starts[-1])
        if self.n == 0:
            raise ValueError(f"{self.dir}: no records")
        self.val_n = min(HOLDOUT_MAX, self.n // 20)
        self.train_n = self.n - self.val_n

    def take(self, idx: np.ndarray) -> np.ndarray:
        """Records at global indices `idx` as an (len(idx), record_bytes) uint8 array."""
        idx = np.asarray(idx, dtype=np.int64)
        out = np.empty((len(idx), self.record_bytes), dtype=np.uint8)
        which = np.searchsorted(self.starts, idx, side="right") - 1
        for s in np.unique(which):
            sel = which == s
            out[sel] = self.arrays[s][idx[sel] - self.starts[s]]
        return out

    def sample(self, rng: np.random.Generator, batch: int) -> np.ndarray:
        return self.take(np.sort(rng.integers(0, self.train_n, size=batch)))

    def val_batches(self, batch: int):
        for lo in range(self.train_n, self.n, batch):
            yield self.take(np.arange(lo, min(lo + batch, self.n)))


def decode_policy(rec: np.ndarray) -> dict[str, torch.Tensor]:
    """Policy records (N, 600) -> planes (N, 18, 8, 8) float32, legal mask (N, 4168) bool, move (N,) int64, result (N,) int64.

    Planes match encode.ts `encodeRel`: 0..11 one-hot piece codes 1..12, 12..15 castling right bits, 16 en passant, 17 halfmove / 100."""
    r = torch.from_numpy(np.ascontiguousarray(rec))
    n = r.shape[0]
    board = r[:, :64].long()
    pieces = torch.nn.functional.one_hot(board, 13)[:, :, 1:].permute(0, 2, 1).float()
    castling = ((r[:, 64:65].long() >> _SHIFTS4) & 1).float().unsqueeze(2).expand(n, 4, 64)
    ep = r[:, 65].long()
    ep_plane = torch.zeros(n, 64)
    valid = ep < 64
    ep_plane[valid, ep[valid]] = 1.0
    halfmove = (r[:, 66].float() / 100.0).unsqueeze(1).unsqueeze(2).expand(n, 1, 64)
    planes = torch.cat([pieces, castling, ep_plane.unsqueeze(1), halfmove], dim=1).reshape(n, PLANES, 8, 8)
    bits = (r[:, 72 : 72 + _MASK_BYTES].long().unsqueeze(2) >> _SHIFTS8) & 1
    mask = bits.reshape(n, _MASK_BYTES * 8)[:, :REL_POLICY_SIZE].bool()
    move = r[:, 68].long() | (r[:, 69].long() << 8)
    return {"planes": planes, "mask": mask, "move": move, "result": r[:, 67].long()}


def decode_value(rec: np.ndarray) -> tuple[torch.Tensor, torch.Tensor]:
    """Value records (N, 68) -> multi-hot features (N, 768) float32 and mover expected score (N,) float32."""
    rec = np.ascontiguousarray(rec)
    feats = torch.from_numpy(rec[:, : 2 * MAX_ACTIVE].copy().view("<u2").astype(np.int64))
    x = torch.zeros(rec.shape[0], SPARSE_FEATURES + 1)
    x.scatter_(1, torch.where(feats == PAD_FEATURE, SPARSE_FEATURES, feats), 1.0)
    target = torch.from_numpy(rec[:, 2 * MAX_ACTIVE :].copy().view("<f4")[:, 0].copy())
    return x[:, :SPARSE_FEATURES], target
