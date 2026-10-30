"""Plays a trained policy against the scripted bots over the real env.

    scripts/py -m trainer.ppo.eval_bots --ckpt <ckpt or snapshot .pt> [--games 200] [--level champion] [--bots random,rushdown,turtle]

A game is one best-of-3 match (the arena: first to 7 rounds). The learner plays both seats equally, each env counts
exactly its first k matches, and actions are sampled from the policy (the shipped behaviour) unless --greedy. Bots
play under the same level limits and the same delayed view as the learner. Reports wins, draws and losses with a 95%
Wilson interval on the score.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import torch

from ..bridge import BridgeEnv
from . import league as L
from .ppo import Agent
from .train_realtime import GAMES, agent_from_state, read_weights


def wilson(successes: float, n: int, z: float = 1.959964) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = successes / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - m) / d, (c + m) / d)


def eval_seats(n_envs: int) -> np.ndarray:
    count = max(4, ((n_envs + 3) // 4) * 4)
    return (np.arange(count) // 2) % 2


def evaluate(agent: Agent, bot: str, games: int, *, game: str = "fighter", level: str = "champion", n_envs: int = 16,
             greedy: bool = False, seed: int = 90_000, max_steps: int = 400_000, rounds: int | None = None, seat: int | None = None) -> dict:
    """Plays the learner against one scripted bot, balanced over both seats and over envs (R15, F6).

    Env i alternates seats in pairs (n_envs is rounded up to a multiple of four), and every env counts exactly
    its first k finished matches, k = ceil(games / n_envs): a count of "the first N matches across envs" would
    over-sample short matches, because short matches finish first. The bot plays under the same level limits and
    the same delayed view as the learner (the env does that). Returns wins, draws, losses (the learner's),
    games (n_envs * k), the score and its Wilson interval.

    With `seat` (0 or 1) every env puts the learner on that seat, which is the seat the page gives the AI; the result
    always carries `bySeat`, the wins, draws, losses and score per learner seat, so a pass on average cannot hide a
    seat that loses (judge coldstore-r2).

    With `rounds` it counts, per env, whole matches until that env has at least ceil(rounds / n_envs) rounds
    (the arena's metric; a match is about 15 rounds) and adds roundsWon, roundsPlayed, roundWinRate and roundCi95.
    """
    agent.eval()
    seat_of = eval_seats(n_envs)
    n_envs = len(seat_of)
    if seat is not None:
        seat_of = np.full(n_envs, int(seat))
    pinned = seat
    seat = seat_of
    rows = np.arange(n_envs)
    per_env = max(1, math.ceil(games / n_envs))
    rounds_per_env = None if rounds is None else max(1, math.ceil(rounds / n_envs))
    act = np.zeros((n_envs, 2, len(agent.nvec)), np.int32)
    sentinel = L.bot_action(bot, len(agent.nvec), game)
    act[rows, 1 - seat] = sentinel
    matches = np.zeros(n_envs, np.int64)
    rounds_done = np.zeros(n_envs, np.int64)
    wins = draws = losses = 0
    per_seat = {0: [0, 0, 0], 1: [0, 0, 0]}
    rounds_won = rounds_played = 0
    with BridgeEnv(game, n_envs, seed=seed, level=level) as env, torch.no_grad():
        obs = env.reset()
        for _ in range(max_steps):
            own = torch.from_numpy(np.ascontiguousarray(obs[rows, seat]))
            act[rows, seat] = agent.sample_actions(own, greedy=greedy).numpy()
            obs, _, _, infos = env.step(act)
            for info in infos:
                i = int(info["env"])
                if (rounds_per_env is None and matches[i] >= per_env) or (rounds_per_env is not None and rounds_done[i] >= rounds_per_env):
                    continue
                w = info["winner"]
                me = int(seat[i])
                wins, draws, losses = wins + (w == me), draws + (w is None), losses + (w is not None and w != me)
                per_seat[me][0] += int(w == me)
                per_seat[me][1] += int(w is None)
                per_seat[me][2] += int(w is not None and w != me)
                matches[i] += 1
                sc = info["score"]
                rounds_won += int(sc[me])
                # Rounds played include drawn rounds (a timeout with equal health), which no seat wins.
                played = int(info.get("rounds", int(sc[0]) + int(sc[1])))
                rounds_played += played
                rounds_done[i] += played
            if rounds_per_env is None and (matches >= per_env).all():
                break
            if rounds_per_env is not None and (rounds_done >= rounds_per_env).all():
                break
    n = wins + draws + losses
    score = (wins + 0.5 * draws) / max(n, 1)
    lo, hi = wilson(wins + 0.5 * draws, n)
    out = {"bot": bot, "games": n, "wins": int(wins), "draws": int(draws), "losses": int(losses), "winRate": wins / max(n, 1),
           "score": score, "ci95": [round(lo, 4), round(hi, 4)]}
    out["bySeat"] = {str(k): {"games": sum(v), "wins": v[0], "draws": v[1], "losses": v[2], "score": (v[0] + 0.5 * v[1]) / max(sum(v), 1)} for k, v in per_seat.items()}
    if pinned is not None:
        out["seat"] = int(pinned)
    if rounds is not None:
        rlo, rhi = wilson(rounds_won, rounds_played)
        out.update({"roundsWon": rounds_won, "roundsPlayed": rounds_played, "roundWinRate": rounds_won / max(rounds_played, 1),
                    "roundCi95": [round(rlo, 4), round(rhi, 4)]})
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--game", default="fighter")
    ap.add_argument("--games", type=int, default=200)
    ap.add_argument("--level", default="champion")
    ap.add_argument("--bots", default=None, help="default: every scripted bot of the game")
    ap.add_argument("--rounds", type=int, default=None, help="play whole matches until this many rounds are played (arena)")
    ap.add_argument("--seat", type=int, choices=(0, 1), default=None, help="put the learner on this seat only (the page seats the AI on seat 1)")
    ap.add_argument("--greedy", action="store_true")
    a = ap.parse_args(argv)
    with BridgeEnv(a.game, 2, seed=1, level=a.level) as probe:
        obs_size = int(probe.obs_shape[-1])
    # A checkpoint from before R15 is widened to the env's observation and heads (identical behaviour, keep never chosen).
    agent = agent_from_state(read_weights(Path(a.ckpt)), GAMES[a.game].nvec, legacy_nvec=GAMES[a.game].legacy_nvec, obs_size=obs_size, keep_bias=-30.0)
    bots = a.bots.split(",") if a.bots else list(L.BOTS[a.game])
    out = [evaluate(agent, b, a.games, game=a.game, level=a.level, greedy=a.greedy, rounds=a.rounds, seat=a.seat) for b in bots]
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
