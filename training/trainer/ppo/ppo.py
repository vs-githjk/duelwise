# Derived from CleanRL's ppo.py (https://github.com/vwxyzjn/cleanrl/blob/master/cleanrl/ppo.py).
#
# MIT License
#
# Copyright (c) 2019 CleanRL developers
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
#
# Changes from CleanRL: a multi-discrete action space with one shared trunk (as benchmarked in T7),
# the rollout and the environment loop live in train_realtime.py (batched bridge envs, a league of
# opponents), the learning-rate schedule is constant (stage targets are cumulative across runs), and
# the update is a plain function over a flat batch.

"""PPO pieces: the policy/value network, GAE, and the clipped-objective update."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch
import torch.nn as nn
from torch.distributions import Categorical


def layer_init(layer: nn.Linear, std: float = float(np.sqrt(2)), bias_const: float = 0.0) -> nn.Linear:
    nn.init.orthogonal_(layer.weight, std)
    nn.init.constant_(layer.bias, bias_const)
    return layer


class Agent(nn.Module):
    """MLP 2x256 (tanh) with one logits head per action dimension and a value head."""

    def __init__(self, obs_size: int, nvec: tuple[int, ...] | list[int], hidden: int = 256):
        super().__init__()
        self.obs_size = int(obs_size)
        self.nvec = tuple(int(n) for n in nvec)
        self.hidden = int(hidden)
        self.trunk = nn.Sequential(
            layer_init(nn.Linear(self.obs_size, hidden)), nn.Tanh(),
            layer_init(nn.Linear(hidden, hidden)), nn.Tanh(),
        )
        self.actor = layer_init(nn.Linear(hidden, sum(self.nvec)), std=0.01)
        self.critic = layer_init(nn.Linear(hidden, 1), std=1.0)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Concatenated logits (B, sum(nvec)) and values (B,)."""
        h = self.trunk(x)
        return self.actor(h), self.critic(h).squeeze(-1)

    def value(self, x: torch.Tensor) -> torch.Tensor:
        return self.critic(self.trunk(x)).squeeze(-1)

    def _dists(self, logits: torch.Tensor) -> list[Categorical]:
        return [Categorical(logits=l, validate_args=False) for l in torch.split(logits, list(self.nvec), dim=-1)]

    def act(self, x: torch.Tensor, action: torch.Tensor | None = None):
        """Returns (action (B, dims) long, logprob (B,), entropy (B,), value (B,))."""
        logits, value = self(x)
        dists = self._dists(logits)
        if action is None:
            action = torch.stack([d.sample() for d in dists], dim=-1)
        logp = sum(d.log_prob(action[:, i]) for i, d in enumerate(dists))
        ent = sum(d.entropy() for d in dists)
        return action, logp, ent, value

    def sample_actions(self, x: torch.Tensor, greedy: bool = False) -> torch.Tensor:
        logits = self.actor(self.trunk(x))
        parts = torch.split(logits, list(self.nvec), dim=-1)
        if greedy:
            return torch.stack([p.argmax(-1) for p in parts], dim=-1)
        return torch.stack([Categorical(logits=p, validate_args=False).sample() for p in parts], dim=-1)


@dataclass
class PPOConfig:
    lr: float = 3e-4
    gamma: float = 0.99
    gae_lambda: float = 0.95
    clip_coef: float = 0.2
    ent_coef: float = 0.01
    vf_coef: float = 0.5
    max_grad_norm: float = 0.5
    epochs: int = 4
    minibatch: int = 4096
    target_kl: float | None = 0.05
    norm_adv: bool = True


def compute_gae(
    rewards: np.ndarray, values: np.ndarray, dones: np.ndarray, next_value: np.ndarray, next_done: np.ndarray,
    gamma: float, lam: float,
) -> tuple[np.ndarray, np.ndarray]:
    """CleanRL's GAE. `dones[t]` is the done flag that came with obs[t] (the episode ended just before it),
    `next_done` the same for the observation after the last step. Shapes (T, N) and (N,)."""
    T = rewards.shape[0]
    adv = np.zeros_like(rewards)
    last = np.zeros_like(next_value)
    for t in reversed(range(T)):
        if t == T - 1:
            nonterminal, nxt = 1.0 - next_done, next_value
        else:
            nonterminal, nxt = 1.0 - dones[t + 1], values[t + 1]
        delta = rewards[t] + gamma * nxt * nonterminal - values[t]
        last = delta + gamma * lam * nonterminal * last
        adv[t] = last
    return adv, adv + values


def ppo_update(
    agent: Agent, optimizer: torch.optim.Optimizer, cfg: PPOConfig,
    obs: torch.Tensor, actions: torch.Tensor, logp: torch.Tensor, adv: torch.Tensor, ret: torch.Tensor,
    generator: torch.Generator | None = None,
) -> dict[str, float]:
    """`cfg.epochs` passes of clipped-objective minibatch updates over a flat batch. Returns mean losses."""
    n = obs.shape[0]
    stats = {"pg_loss": 0.0, "v_loss": 0.0, "entropy": 0.0, "approx_kl": 0.0, "clipfrac": 0.0}
    count = 0
    stop = False
    for _ in range(cfg.epochs):
        perm = torch.randperm(n, generator=generator)
        for s in range(0, n, cfg.minibatch):
            idx = perm[s : s + cfg.minibatch]
            _, new_logp, ent, new_value = agent.act(obs[idx], actions[idx])
            log_ratio = new_logp - logp[idx]
            ratio = log_ratio.exp()
            with torch.no_grad():
                approx_kl = ((ratio - 1) - log_ratio).mean()
                clipfrac = ((ratio - 1.0).abs() > cfg.clip_coef).float().mean()
            mb_adv = adv[idx]
            if cfg.norm_adv and mb_adv.numel() > 1:
                mb_adv = (mb_adv - mb_adv.mean()) / (mb_adv.std() + 1e-8)
            pg_loss = torch.max(-mb_adv * ratio, -mb_adv * ratio.clamp(1 - cfg.clip_coef, 1 + cfg.clip_coef)).mean()
            v_loss = 0.5 * (new_value - ret[idx]).pow(2).mean()
            entropy = ent.mean()
            loss = pg_loss - cfg.ent_coef * entropy + cfg.vf_coef * v_loss
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(agent.parameters(), cfg.max_grad_norm)
            optimizer.step()
            for k, v in (("pg_loss", pg_loss), ("v_loss", v_loss), ("entropy", entropy), ("approx_kl", approx_kl), ("clipfrac", clipfrac)):
                stats[k] += float(v.detach())
            count += 1
            if cfg.target_kl is not None and float(approx_kl) > cfg.target_kl:
                stop = True
                break
        if stop:
            break
    return {k: v / max(count, 1) for k, v in stats.items()}
