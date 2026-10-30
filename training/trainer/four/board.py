"""Four in a Row positions for the learner. Mirrors packages/core/src/games/four (encode.ts):
3 planes of 6 x 7 with row 0 at the bottom: stones of the seat to act, the other seat's stones, a turn plane of ones."""

from __future__ import annotations

import numpy as np

ROWS, COLS = 6, 7
PLANES = 3
OBS_SIZE = PLANES * ROWS * COLS


def replay_game(moves: list[int], visits: list[list[int]], winner: int | None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Turns one finished game into training rows, one per ply.

    Returns (planes uint8 (T, 2, 6, 7): own then opponent stones from the mover's view,
    policy float32 (T, 7): visit shares, z float32 (T,): +1 if the mover of that ply won, -1 if lost, 0 draw)."""
    t = len(moves)
    if len(visits) != t:
        raise ValueError("moves and visits differ in length")
    planes = np.zeros((t, 2, ROWS, COLS), dtype=np.uint8)
    policy = np.zeros((t, COLS), dtype=np.float32)
    z = np.zeros(t, dtype=np.float32)
    board = np.zeros((ROWS, COLS), dtype=np.int8)  # 0 empty, 1 seat 0, 2 seat 1
    heights = [0] * COLS
    for ply, col in enumerate(moves):
        seat = ply % 2
        mine, theirs = (1, 2) if seat == 0 else (2, 1)
        planes[ply, 0] = board == mine
        planes[ply, 1] = board == theirs
        v = np.asarray(visits[ply], dtype=np.float32)
        policy[ply] = v / max(float(v.sum()), 1.0)
        z[ply] = 0.0 if winner is None else (1.0 if winner == seat else -1.0)
        if not 0 <= col < COLS or heights[col] >= ROWS:
            raise ValueError(f"illegal move {col} at ply {ply}")
        board[heights[col], col] = 1 + seat
        heights[col] += 1
    return planes, policy, z


def to_input(planes: np.ndarray) -> np.ndarray:
    """(N, 2, 6, 7) uint8 stones -> (N, 3, 6, 7) float32 network input with the constant turn plane."""
    n = planes.shape[0]
    out = np.ones((n, PLANES, ROWS, COLS), dtype=np.float32)
    out[:, :2] = planes
    return out


def mirror(planes: np.ndarray, policy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Left-right mirror: the game is symmetric, so this doubles the data for free."""
    return planes[..., ::-1].copy(), policy[:, ::-1].copy()
