"""Prioritised fictitious self-play (PFSP) league: the learner's opponent pool.

The pool is the scripted bots (always there) plus the 16 most recent learner snapshots. Each episode
an env draws its opponent with weight (1 - p)^2, where p is the learner's recent score against that
opponent, so the learner spends its games on opponents it still loses to. A beaten opponent keeps a
small floor weight so a regression against it is noticed. Stage B (a level-limited learner) keeps the
Champion stage's latest snapshots as frozen opponents next to its own rolling ones.
"""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..paths import atomic_write_bytes

# Order matters: it matches FIGHTER_BOT_KINDS / ARENA_BOT_KINDS in the env, whose bot sentinel is the first action head = -1 - index.
BOT_KINDS = ("random", "rushdown", "turtle", "zoner", "throwloop", "backwalk", "pokeloop", "sweepspam", "fireball", "throwtap", "fireball25")
BOTS = {"fighter": BOT_KINDS, "arena": ("random", "rusher", "holder", "peeker", "strafe", "holdangle", "human-proxy"),
        # PUCK_BOT_KINDS in games/puck/env.ts (the sentinel x head = -1 - index)
        "puck": ("random", "striker", "goalie", "banker", "shadow")}
TRAINING_BOTS = {"fighter": BOT_KINDS, "arena": tuple(bot for bot in BOTS["arena"] if bot != "human-proxy"), "puck": BOTS["puck"]}
# People bots (puck, Nov 10 retune): a scripted bot on a person's hands, named "<kind>@<profile>". The env's sentinel is
# -1 - (16 * (profile + 1) + kind) (PEOPLE_BOT_KINDS and PEOPLE_PROFILES in games/puck/seat-hands.ts; the env test pins both).
PEOPLE_PROFILES = ("beginner", "average", "strong")
PEOPLE_BOT_KINDS = ("mouse", "striker", "goalie", "banker", "shadow")
# Tinderbox and Coldstore (A4): the same names, with the game's own scripted bots as the people's styles. The sentinel's kind part is the bot's
# index in BOTS[game] (FIGHTER_BOT_KINDS, ARENA_BOT_KINDS), under 16 for both. The panel and the pool use these four to five person-like styles
# (the exploit loops are gate bots, not people).
PEOPLE_KINDS = {"puck": PEOPLE_BOT_KINDS, "fighter": ("rushdown", "turtle", "zoner", "fireball"), "arena": ("rusher", "holder", "peeker", "strafe", "holdangle")}


def people_bots(profiles: tuple[str, ...], game: str = "puck") -> tuple[str, ...]:
    """Every people bot name for the given profiles, in sentinel order."""
    for p in profiles:
        if p not in PEOPLE_PROFILES:
            raise ValueError(f"unknown people profile {p!r}; expected one of {PEOPLE_PROFILES}")
    return tuple(f"{k}@{p}" for p in profiles for k in PEOPLE_KINDS[game])


def people_kind_index(base: str, game: str) -> int:
    """The kind part of a people sentinel: puck's own order, otherwise the bot's index in the game's scripted bots."""
    return PEOPLE_BOT_KINDS.index(base) if game == "puck" else BOTS[game].index(base)


MAX_SNAPSHOTS = 16
PFSP_POWER = 2.0
PFSP_FLOOR = 0.02
WINDOW = 100


def bot_action(kind: str, dims: int = 2, game: str = "fighter") -> list[int]:
    """The action the env reads as 'play this seat with that scripted bot': the sentinel in the first head, zeros after it."""
    if "@" in kind:
        base, profile = kind.split("@", 1)
        return [-1 - (16 * (PEOPLE_PROFILES.index(profile) + 1) + people_kind_index(base, game))] + [0] * (dims - 1)
    return [-1 - BOTS[game].index(kind)] + [0] * (dims - 1)


def pfsp_weights(win_rates: np.ndarray, power: float = PFSP_POWER, floor: float = PFSP_FLOOR) -> np.ndarray:
    """Normalised (1 - p)^power with every weight at least `floor` times the largest possible weight."""
    p = np.clip(np.asarray(win_rates, dtype=np.float64), 0.0, 1.0)
    w = np.maximum((1.0 - p) ** power, floor)
    return w / w.sum()


@dataclass
class Entry:
    name: str
    kind: str  # "bot" or "snapshot"
    step: int = 0
    state: Any = None  # a snapshot's model state_dict
    results: deque = field(default_factory=lambda: deque(maxlen=WINDOW))

    def win_rate(self) -> float:
        """The learner's recent score against this opponent with a 1 win, 1 loss prior."""
        return (sum(self.results) + 1.0) / (len(self.results) + 2.0)


class League:
    def __init__(self, rng: np.random.Generator | None = None, max_own: int = MAX_SNAPSHOTS, frozen: list[Entry] | None = None,
                 bots: tuple[str, ...] = BOT_KINDS):
        self.rng = rng or np.random.default_rng()
        self.max_own = max_own
        self._bots = [Entry(name=k, kind="bot") for k in bots]
        self._frozen = list(frozen or [])
        self._own: list[Entry] = []

    def entries(self) -> list[Entry]:
        return [*self._bots, *self._frozen, *self._own]

    def add_snapshot(self, name: str, state: Any, step: int) -> Entry:
        e = Entry(name=name, kind="snapshot", step=int(step), state=state)
        # A resumed run can re-reach a step a crashed run already snapshotted: replace, never duplicate.
        self._own = [x for x in self._own if x.name != name]
        self._own.append(e)
        del self._own[: max(0, len(self._own) - self.max_own)]
        return e

    def get(self, name: str) -> Entry:
        for e in self.entries():
            if e.name == name:
                return e
        raise KeyError(name)

    def record(self, name: str, score: float) -> None:
        """score: 1 learner won, 0.5 draw, 0 learner lost."""
        for e in self.entries():
            if e.name == name:
                e.results.append(float(score))
                return
        # An opponent that has left the pool (evicted snapshot) has nothing left to update.

    def weights(self) -> np.ndarray:
        return pfsp_weights(np.array([e.win_rate() for e in self.entries()]))

    def sample(self) -> Entry:
        es = self.entries()
        return es[int(self.rng.choice(len(es), p=self.weights()))]

    def summary(self) -> dict[str, float]:
        return {e.name: round(e.win_rate(), 3) for e in self.entries()}


_SNAP = re.compile(r"^snap-(\w+)-(\d{10})\.pt$")


def save_snapshot(directory: Path | str, stage_key: str, step: int, state: Any) -> Path:
    import io

    import torch

    buf = io.BytesIO()
    torch.save({"step": int(step), "stage": stage_key, "model": state}, buf)
    path = Path(directory) / f"snap-{stage_key}-{int(step):010d}.pt"
    atomic_write_bytes(path, buf.getvalue())
    return path


def load_snapshots(directory: Path | str, latest: int = MAX_SNAPSHOTS) -> list[Entry]:
    """The `latest` newest snapshots in a directory as pool entries, oldest first."""
    import torch

    d = Path(directory)
    if not d.is_dir():
        return []
    files = sorted((p for p in d.iterdir() if _SNAP.match(p.name)), key=lambda p: p.name.rsplit("-", 1)[1])
    out: list[Entry] = []
    for p in files[-latest:]:
        try:
            data = torch.load(p, map_location="cpu", weights_only=False)
        except Exception:  # a torn file is skipped; the atomic write makes this rare
            continue
        out.append(Entry(name=p.stem, kind="snapshot", step=int(data["step"]), state=data["model"]))
    return out
