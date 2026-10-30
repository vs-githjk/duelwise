"""Widens a v1 policy (before R15) to the v2 observation and action heads without changing what it does.

The v2 env appends the seat's own-input features to the observation and adds one action value (the fighter's
KEEP button, the arena's KEEP move). A v1 network gets zero input columns for the new features, so its logits
on the old values are identical for any input, and new logit rows with zero weights and a negative bias, so the
new "keep" value starts rare (`keep_bias`) and PPO decides how much to use it.
"""

from __future__ import annotations

import torch


def widen_state(state: dict, obs_size: int, from_nvec: tuple[int, ...], to_nvec: tuple[int, ...], keep_bias: float = -2.0) -> dict:
    """A copy of a policy state_dict for an `obs_size` observation and the heads `to_nvec` (each head at least as big as in `from_nvec`)."""
    if len(from_nvec) != len(to_nvec) or any(t < f for f, t in zip(from_nvec, to_nvec)):
        raise ValueError(f"cannot widen heads {from_nvec} to {to_nvec}")
    out = {k: v.clone() for k, v in state.items()}
    w = out["trunk.0.weight"]
    hidden, old_obs = int(w.shape[0]), int(w.shape[1])
    if old_obs > obs_size:
        raise ValueError(f"cannot shrink the observation from {old_obs} to {obs_size}")
    if old_obs < obs_size:
        out["trunk.0.weight"] = torch.cat([w, torch.zeros(hidden, obs_size - old_obs, dtype=w.dtype)], dim=1)
    if tuple(from_nvec) != tuple(to_nvec):
        aw, ab = out["actor.weight"], out["actor.bias"]
        if int(aw.shape[0]) != sum(from_nvec):
            raise ValueError(f"actor has {int(aw.shape[0])} rows, expected {sum(from_nvec)} for heads {from_nvec}")
        rows_w, rows_b = [], []
        o = 0
        for f, t in zip(from_nvec, to_nvec):
            rows_w.append(aw[o : o + f])
            rows_b.append(ab[o : o + f])
            if t > f:
                rows_w.append(torch.zeros(t - f, aw.shape[1], dtype=aw.dtype))
                rows_b.append(torch.full((t - f,), keep_bias, dtype=ab.dtype))
            o += f
        out["actor.weight"] = torch.cat(rows_w, dim=0)
        out["actor.bias"] = torch.cat(rows_b, dim=0)
    return out
