"""Real-time PPO plus PFSP league trainer (T8).

One stage, as the plan describes it:

    scripts/py -m trainer.ppo.train_realtime --game fighter --stage A --steps 20000000 [--resume]
    scripts/py -m trainer.ppo.train_realtime --game fighter --stage B --level hard --steps 8000000 --init <champion ckpt>

Stage A trains the Champion learner (the fighter env's `champion` limiter: PRODUCT.championMinDelayFrames
of delay, no APM cap). Stage B trains Hard, Medium or Easy from a Champion checkpoint, with that level's
HumanLimiter applied in the env to both seats (every level is trained under its own limits).

The league job runs every stage in order from plan/bench/T7.json budgets (`--league`), resumable from
its checkpoints at any point:

    morning: A, hard, medium, easy   -> runs/<job>/levels/morning.json
    full:    A, hard, medium, easy   -> runs/<job>/levels/full.json   (targets are cumulative, each stage continues)

Layout under the run directory: ckpt/<A|hard|medium|easy>/ckpt-<step>.pt (atomic, resumable),
league/<key>/snap-<key>-<step>.pt (opponent snapshots), levels/*.json, metrics.jsonl, progress.json.

Rollouts: one Bun bridge process per worker thread (`--procs`, default 2 for the job's 2 CPU slots),
learner = seat 0, opponent = seat 1 drawn per env and episode from the league (PFSP). Bots are played
inside the env (see games/fighter/env.ts), snapshots by a frozen net here. The PPO update runs on CPU.
"""

from __future__ import annotations

import argparse
import json
import os
import threading
import zlib
import time
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np
import torch

from ..bridge import BridgeEnv
from ..checkpoint import _NAME as _CKPT_NAME
from ..checkpoint import load_latest, save_checkpoint
from ..jobs import heartbeat
from ..paths import atomic_write_bytes, resolve_runs_path, runs_dir
from . import bc
from . import league as L
from . import gate as G
from .ppo import Agent, PPOConfig, compute_gae, ppo_update
from .widen import widen_state

LEVEL_KEYS = ("hard", "medium", "easy")
STAGE_KEYS = ("A", *LEVEL_KEYS)
BUDGET_KEY = {"A": "stageA", "hard": "hard", "medium": "medium", "easy": "easy"}
EASY_INIT_FRACTION = 0.25  # Easy starts from the Champion as it was a quarter of the way through stage A


@dataclass(frozen=True)
class GameSpec:
    nvec: tuple[int, ...]
    # The heads before R15 (no keep value); checkpoints trained then load through widen_state.
    legacy_nvec: tuple[int, ...]
    # PPOConfig overrides for this game (the fighter keeps the defaults).
    ppo: dict = field(default_factory=dict)
    # Stage B entropy bonus, annealed linearly from the first to the second over the stage's steps (R15).
    ent_anneal: tuple[float, float] = (0.01, 0.001)


GAMES: dict[str, GameSpec] = {
    # direction (9), button (7) plus KEEP (the 8th value: hold the current input, free); see games/fighter/env.ts
    "fighter": GameSpec(nvec=(9, 8), legacy_nvec=(9, 7)),
    # move (9) plus KEEP, walk, crouch, jump, fire, reload (2 each), yaw bin (9), pitch bin (7), buy (4); see games/arena/actions.ts
    # Nine heads need many more gradient steps per sample than the fighter's two: smaller minibatches. A low entropy bonus: the policy starts from a behaviour-cloned copy of the rusher and a bonus of 0.005 let its entropy climb (1.8 to 4.2 in 2M steps) once the opponent was far away.
    # Stage B anneals from 0.002, not 0.01: the arena has nine heads and 0.005 already blew its entropy up.
    "arena": GameSpec(nvec=(10, 2, 2, 2, 2, 2, 9, 7, 4), legacy_nvec=(9, 2, 2, 2, 2, 2, 9, 7, 4),
                      ppo={"lr": 3e-4, "minibatch": 1024, "ent_coef": 0.001}, ent_anneal=(0.002, 0.0005)),
}


def game_spec(game: str) -> GameSpec:
    if game not in GAMES:
        raise SystemExit(f"train_realtime: game {game!r} has no trainer yet (known: {', '.join(GAMES)})")
    return GAMES[game]


# ---------------------------------------------------------------- stage configuration


@dataclass(frozen=True)
class StageCfg:
    stage: str  # "A" or "B"
    level: str  # champion for A, else hard|medium|easy
    env_level: str  # the level the bridge env applies to both seats
    init: Path | None


def make_stage(stage: str, level: str | None, init: Path | str | None) -> StageCfg:
    if stage == "A":
        return StageCfg("A", "champion", "champion", Path(init) if init else None)
    if stage != "B":
        raise ValueError(f"stage must be A or B, got {stage!r}")
    if level not in LEVEL_KEYS:
        raise ValueError(f"stage B level must be one of {LEVEL_KEYS}, got {level!r}")
    if not init:
        raise ValueError("stage B starts from a Champion checkpoint: pass --init")
    return StageCfg("B", level, level, Path(init))


def native_nvec(state: dict, game: str) -> tuple[int, ...]:
    """The action heads a saved state was trained with: the game's current heads or its pre-R15 ones."""
    spec = game_spec(game)
    rows = int(state["actor.weight"].shape[0])
    for nv in (spec.nvec, spec.legacy_nvec):
        if rows == sum(nv):
            return nv
    raise ValueError(f"policy has {rows} action logits, matching neither {spec.nvec} nor {spec.legacy_nvec}")


def agent_from_state(state: dict, nvec: tuple[int, ...], *, legacy_nvec: tuple[int, ...] | None = None, obs_size: int | None = None,
                     keep_bias: float = -2.0) -> Agent:
    """The network for a saved state. A pre-R15 state (the legacy heads) is widened to `nvec`, and to `obs_size` features when given."""
    rows = int(state["actor.weight"].shape[0])
    if rows != sum(nvec):
        if legacy_nvec is None or rows != sum(legacy_nvec):
            raise ValueError(f"policy has {rows} action logits; expected {sum(nvec)} for heads {nvec}")
        state = widen_state(state, int(state["trunk.0.weight"].shape[1]), legacy_nvec, nvec, keep_bias)
    if obs_size is not None and int(state["trunk.0.weight"].shape[1]) != obs_size:
        state = widen_state(state, obs_size, nvec, nvec, keep_bias)
    a = Agent(int(state["trunk.0.weight"].shape[1]), nvec, int(state["trunk.0.weight"].shape[0]))
    a.load_state_dict(state)
    return a


def read_weights(path: Path | str) -> dict:
    data = torch.load(path, map_location="cpu", weights_only=False)
    return data["model"]


def build_agent(cfg: StageCfg, obs_size: int, nvec: tuple[int, ...], legacy_nvec: tuple[int, ...] | None = None) -> Agent:
    if cfg.init is None:
        return Agent(obs_size, nvec)
    return agent_from_state(read_weights(cfg.init), nvec, legacy_nvec=legacy_nvec, obs_size=obs_size)


@dataclass(frozen=True)
class PlanItem:
    phase: str  # morning | full
    key: str  # A | hard | medium | easy
    target: int


def stage_plan(budgets: dict) -> list[PlanItem]:
    return [PlanItem(phase, key, int(budgets[phase][BUDGET_KEY[key]])) for phase in ("morning", "full") for key in STAGE_KEYS]


def ckpt_steps(ckpt_dir: Path) -> list[tuple[int, Path]]:
    if not ckpt_dir.is_dir():
        return []
    out = [(int(m.group(1)), p) for p in ckpt_dir.iterdir() if (m := _CKPT_NAME.match(p.name))]
    return sorted(out)


def first_ckpt_at_or_after(ckpt_dir: Path, step: int) -> tuple[int, Path] | None:
    for s, p in ckpt_steps(ckpt_dir):
        if s >= step:
            return s, p
    return None


# ---------------------------------------------------------------- the trainer


@dataclass
class RunPaths:
    ckpt: Path
    league: Path
    frozen: list[Path] = field(default_factory=list)
    run_dir: Path | None = None


def _log(*a) -> None:
    print(*a, flush=True)


class Trainer:
    def __init__(
        self, game: str, cfg: StageCfg, paths: RunPaths, *, procs: int = 2, envs_per_proc: int = 64, rollout: int = 128,
        seed: int = 0, ppo: PPOConfig | None = None, snapshot_every: int = 1_000_000, ckpt_every_s: float = 900.0,
        threads: int | None = None, log=None, close_steps: int = 0, warm_start: int = 0,
        gate_every: int = 2_000_000, gate_games: int = 48, gate_enabled: bool = True, gate_stage_a: bool = False,
    ):
        self.game, self.cfg, self.paths = game, cfg, paths
        # Arena stage A only: the close-range curriculum (env level "<level>@close") until this many total steps.
        self.close_steps = close_steps if cfg.stage == "A" else 0
        # Arena stage A only: a fresh run first fits the policy to this many decisions of the rusher and holder bots (bc.py).
        self.warm_start = warm_start if (cfg.stage == "A" and game == "arena") else 0
        self.env_level = cfg.env_level
        self.spec = game_spec(game)
        # Stage B only (R15): every `gate_every` steps the snapshot plays the scripted bots under the level's limits.
        self.gate_every, self.gate_games = gate_every, gate_games
        # b3 (R30) also gates the Champion (stage A, level "champion") because it now has exploit bars.
        self.gate_on = gate_enabled and (cfg.stage == "B" or gate_stage_a) and paths.run_dir is not None
        self.next_gate = 0
        self.procs, self.envs_per_proc, self.rollout = procs, envs_per_proc, rollout
        self.seed = seed
        self.ppo = ppo or PPOConfig(**self.spec.ppo)
        self.snapshot_every = snapshot_every
        self.ckpt_every_s = ckpt_every_s
        self.log = log or _log
        torch.set_num_threads(threads or max(procs, 1))
        self.rng = np.random.default_rng(seed)
        self._lock = threading.Lock()
        self.step = 0
        self.agent: Agent | None = None

    # -- setup

    def _frozen_entries(self) -> list[L.Entry]:
        out: list[L.Entry] = []
        for d in self.paths.frozen:
            out += L.load_snapshots(d, latest=8)
        return out

    def _setup(self, obs_size: int, resume: bool) -> None:
        self.agent = build_agent(self.cfg, obs_size, self.spec.nvec, self.spec.legacy_nvec)
        self.opt = torch.optim.Adam(self.agent.parameters(), lr=self.ppo.lr, eps=1e-5)
        self.step = 0
        if resume:
            info = load_latest(self.paths.ckpt, self.agent, self.opt)
            if info:
                self.step = info["step"]
                self.log(f"resumed {self.cfg.stage}/{self.cfg.level} at step {self.step:,}")
        elif ckpt_steps(self.paths.ckpt):
            raise SystemExit(f"{self.paths.ckpt} already has checkpoints; pass --resume or use an empty directory")
        if self.step == 0 and self.warm_start > 0 and self.cfg.init is None:
            loss = bc.warm_start(self.agent, self.warm_start, seed=self.seed + 5, log=self.log)
            self.log(f"behaviour-cloning warm start done on {self.warm_start:,} decisions, loss {loss:.4f}")
        frozen = self._frozen_entries()
        own_max = L.MAX_SNAPSHOTS - len(frozen)
        self.league = L.League(rng=self.rng, max_own=own_max, frozen=frozen, bots=L.TRAINING_BOTS[self.game])
        for e in L.load_snapshots(self.paths.league, latest=own_max):
            self.league.add_snapshot(e.name, e.state, e.step)
        self._nets: dict[str, Agent] = {}

    def _opp_net(self, e: L.Entry) -> Agent:
        net = self._nets.get(e.name)
        if net is None:
            # Stage A snapshots from before R15 are widened to this env's observation; their keep value is never chosen.
            net = agent_from_state(e.state, self.spec.nvec, legacy_nvec=self.spec.legacy_nvec, obs_size=self.agent.obs_size, keep_bias=-30.0).eval()
            for p in net.parameters():
                p.requires_grad_(False)
            self._nets[e.name] = net
        return net

    def _pick(self) -> str:
        with self._lock:
            return self.league.sample().name

    def _ppo_now(self, target: int) -> PPOConfig:
        """The PPO config for this update: in stage B the entropy bonus anneals from the game's start value to its end value."""
        if self.cfg.stage != "B":
            return self.ppo
        lo, hi = self.spec.ent_anneal
        frac = min(max(self.step / max(target, 1), 0.0), 1.0)
        return replace(self.ppo, ent_coef=lo + (hi - lo) * frac)

    # -- the scripted-bot gate (R15)

    def _run_gate(self, state: dict) -> None:
        """Plays the current weights against the scripted bots under this level's limits and records pass or fail."""
        run_dir = self.paths.run_dir
        agent = self.agent
        result = G.gate_check(agent, self.game, self.cfg.level, games_per_bot=self.gate_games, seed=70_000 + self.step % 9973)
        agent.train()
        result["step"] = self.step
        G.record_gate(run_dir, self.game, self.cfg.level, self.step, result, state)
        self.log(f"gate {self.cfg.level} step {self.step:,}: {'PASS' if result['passed'] else 'fail'} " + json.dumps(
            {b: v["score"] for b, v in result["bots"].items()}))

    # -- rollout

    def _rollout_proc(self, p: int, out: dict, counters: dict) -> None:
        env = self.envs[p]
        n, R = self.envs_per_proc, self.rollout
        obs, done_flag = self.obs[p], self.done_flag[p]
        names = self.opp_names[p]
        agent = self.agent
        size = obs.shape[-1]
        b_obs = np.empty((R, n, size), np.float32)
        b_act = np.empty((R, n, len(self.spec.nvec)), np.int64)
        b_logp = np.empty((R, n), np.float32)
        b_val = np.empty((R, n), np.float32)
        b_rew = np.empty((R, n), np.float32)
        b_done = np.empty((R, n), np.float32)
        act = np.zeros((n, 2, len(self.spec.nvec)), np.int32)
        with torch.no_grad():
            for k in range(R):
                x0 = torch.from_numpy(np.ascontiguousarray(obs[:, 0]))
                a0, logp, _, val = agent.act(x0)
                b_obs[k], b_done[k] = obs[:, 0], done_flag
                b_act[k], b_logp[k], b_val[k] = a0.numpy(), logp.numpy(), val.numpy()
                act[:, 0] = a0.numpy()
                x1 = None
                for name in set(names):
                    idx = np.flatnonzero(names == name)
                    entry = self.league.get(name)
                    if entry.kind == "bot":
                        act[idx, 1] = L.bot_action(name, len(self.spec.nvec), self.game)
                    else:
                        if x1 is None:
                            x1 = torch.from_numpy(np.ascontiguousarray(obs[:, 1]))
                        act[idx, 1] = self._opp_net(entry).sample_actions(x1[idx]).numpy()
                obs, rew, done, infos = env.step(act)
                b_rew[k] = rew
                done_flag = done.astype(np.float32)
                counters["steps"] += n
                for info in infos:
                    i = int(info["env"])
                    w = info["winner"]
                    score = 1.0 if w == 0 else 0.5 if w is None else 0.0
                    with self._lock:
                        self.league.record(str(names[i]), score)
                        counters["games"] += 1
                        counters["wins"] += score
                    names[i] = self._pick()
            nv = agent.value(torch.from_numpy(np.ascontiguousarray(obs[:, 0]))).numpy()
        self.obs[p], self.done_flag[p] = obs, done_flag
        adv, ret = compute_gae(b_rew, b_val, b_done, nv, done_flag, self.ppo.gamma, self.ppo.gae_lambda)
        out[p] = (b_obs.reshape(-1, size), b_act.reshape(-1, b_act.shape[-1]), b_logp.reshape(-1), adv.reshape(-1), ret.reshape(-1), float(b_rew.sum()))

    # -- the loop

    def run(self, target: int, *, resume: bool = False, max_seconds: float | None = None, marks: list[int] | None = None) -> int:
        """Trains until `target` total learner steps (or `max_seconds`), saving a checkpoint at the end. Returns the step.

        With `close_steps` (arena stage A) the first steps run in the close-range curriculum, then the
        envs are rebuilt at the normal start and training continues from the checkpoint the first part saved.
        """
        t0 = time.time()
        saved = ckpt_steps(self.paths.ckpt)
        start = saved[-1][0] if resume and saved else 0
        if self.close_steps > start:
            self.env_level = f"{self.cfg.env_level}@close"
            step = self._run(min(target, self.close_steps), resume=resume, max_seconds=max_seconds, marks=marks)
            self.env_level = self.cfg.env_level
            if step < min(target, self.close_steps) or step >= target:
                return step  # stopped by the time cap, or nothing left
            left = None if max_seconds is None else max(max_seconds - (time.time() - t0), 1.0)
            self.log(f"close-range curriculum done at {step:,}; continuing at the normal start")
            return self._run(target, resume=True, max_seconds=left, marks=marks)
        self.env_level = self.cfg.env_level
        return self._run(target, resume=resume, max_seconds=max_seconds, marks=marks)

    def _run(self, target: int, *, resume: bool, max_seconds: float | None, marks: list[int] | None) -> int:
        t_start = time.time()
        self.envs: list[BridgeEnv] = []
        try:
            first = BridgeEnv(self.game, self.envs_per_proc, seed=self.seed, level=self.env_level)
            self.envs.append(first)
            obs_size = int(first.obs_shape[-1])
            self._setup(obs_size, resume)
            for p in range(1, self.procs):
                self.envs.append(BridgeEnv(self.game, self.envs_per_proc, seed=self.seed + 1000 * p, level=self.env_level))
            # Seeds depend on the step so a resumed run does not replay the same matches.
            self.obs = [e.reset([self.seed + 1000 * p + self.step * 7 + i for i in range(self.envs_per_proc)]) for p, e in enumerate(self.envs)]
            self.done_flag = [np.zeros(self.envs_per_proc, np.float32) for _ in self.envs]
            self.opp_names = [np.array([self._pick() for _ in range(self.envs_per_proc)], dtype=object) for _ in self.envs]
            marks_left = sorted(m for m in (marks or []) if m > self.step)
            next_snap = (self.step // self.snapshot_every + 1) * self.snapshot_every
            last_ckpt = last_log = time.time()
            window_steps, window_t = self.step, time.time()
            key = self.cfg.level if self.cfg.stage == "B" else "A"
            while self.step < target:
                if max_seconds is not None and time.time() - t_start > max_seconds:
                    self.log(f"time cap reached at step {self.step:,}")
                    break
                counters = {"steps": 0, "games": 0, "wins": 0.0}
                out: dict = {}
                threads = [threading.Thread(target=self._rollout_proc, args=(p, out, counters)) for p in range(self.procs)]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join()
                if len(out) != self.procs:
                    raise RuntimeError("a rollout worker failed; see the traceback above")
                parts = [out[p] for p in range(self.procs)]
                obs_b = torch.from_numpy(np.concatenate([q[0] for q in parts]))
                act_b = torch.from_numpy(np.concatenate([q[1] for q in parts]))
                logp_b = torch.from_numpy(np.concatenate([q[2] for q in parts]))
                adv_b = torch.from_numpy(np.concatenate([q[3] for q in parts]))
                ret_b = torch.from_numpy(np.concatenate([q[4] for q in parts]))
                stats = ppo_update(self.agent, self.opt, self._ppo_now(target), obs_b, act_b, logp_b, adv_b, ret_b)
                self.step += counters["steps"]
                heartbeat()
                now = time.time()
                if self.step >= next_snap:
                    state = {k: v.detach().clone() for k, v in self.agent.state_dict().items()}
                    L.save_snapshot(self.paths.league, key, self.step, state)
                    self.league.add_snapshot(f"snap-{key}-{self.step:010d}", state, self.step)
                    self._nets.pop(f"snap-{key}-{self.step:010d}", None)  # rebuild the net from the new state
                    next_snap = (self.step // self.snapshot_every + 1) * self.snapshot_every
                    live = {e.name for e in self.league.entries()}
                    self._nets = {k: v for k, v in self._nets.items() if k in live}
                    if self.gate_on and self.step >= self.next_gate:
                        self._run_gate(state)
                        self.next_gate = (self.step // self.gate_every + 1) * self.gate_every
                    # A snapshot pushed out of the pool must not be looked up by a match still running.
                    for names_p in self.opp_names:
                        for i, nm in enumerate(names_p):
                            if str(nm) not in live:
                                names_p[i] = self._pick()
                if marks_left and self.step >= marks_left[0]:
                    self._save(extra_note="mark")
                    marks_left.pop(0)
                if now - last_ckpt >= self.ckpt_every_s:
                    self._save()
                    last_ckpt = now
                if now - last_log >= 20 or self.step >= target:
                    sps = (self.step - window_steps) / max(now - window_t, 1e-9)
                    win = counters["wins"] / counters["games"] if counters["games"] else float("nan")
                    line = {"t": round(now), "stage": self.cfg.stage, "level": self.cfg.level, "step": self.step, "target": target, "sps": round(sps),
                            "games": counters["games"], "winRate": None if counters["games"] == 0 else round(win, 3),
                            "pgLoss": round(stats["pg_loss"], 4), "vLoss": round(stats["v_loss"], 4), "entropy": round(stats["entropy"], 3),
                            "approxKl": round(stats["approx_kl"], 4), "leagueWinRates": self.league.summary()}
                    self.log(json.dumps(line))
                    self._progress(line)
                    last_log, window_steps, window_t = now, self.step, now
            self._save()
            return self.step
        finally:
            for e in self.envs:
                e.close()

    def _save(self, extra_note: str | None = None) -> Path:
        extra = {"stage": self.cfg.stage, "level": self.cfg.level, "obsSize": self.agent.obs_size, "nvec": list(self.spec.nvec), "game": self.game}
        if extra_note:
            extra["note"] = extra_note
        return save_checkpoint(self.paths.ckpt, self.step, self.agent, self.opt, extra=extra)

    def _progress(self, line: dict) -> None:
        d = self.paths.run_dir
        if d is None:
            return
        d.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(d / "progress.json", (json.dumps(line, indent=2) + "\n").encode())
        with open(d / "metrics.jsonl", "a") as f:
            f.write(json.dumps({k: v for k, v in line.items() if k != "leagueWinRates"}) + "\n")


# ---------------------------------------------------------------- the league job


def write_levels(run_dir: Path, phase: str, plan: list[PlanItem]) -> dict:
    """levels/<phase>.json: one checkpoint per level (the first checkpoint at or after the phase target)."""
    levels = {}
    for item in plan:
        if item.phase != phase:
            continue
        hit = first_ckpt_at_or_after(run_dir / "ckpt" / item.key, item.target)
        if hit is None:
            raise RuntimeError(f"no checkpoint at or after {item.target} for {item.key}")
        level = "champion" if item.key == "A" else item.key
        levels[level] = {"path": str(hit[1]), "step": hit[0], "target": item.target}
    data = {"phase": phase, "writtenAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "levels": levels}
    atomic_write_bytes(run_dir / "levels" / f"{phase}.json", (json.dumps(data, indent=2) + "\n").encode())
    return data


def scaled_budgets(budgets: dict, scale: float) -> dict:
    """Every step budget times `scale` (a game whose env is slower than the benchmarked one gets fewer steps for the same hours)."""
    return {phase: {k: int(v * scale) for k, v in b.items()} for phase, b in budgets.items()}


def run_league(game: str, bench: Path, run_dir: Path, *, procs: int = 2, envs_per_proc: int = 64, seed: int = 0,
               snapshot_every: int = 1_000_000, ckpt_every_s: float = 900.0, log=_log, only_phases: tuple[str, ...] = ("morning", "full"),
               budget_scale: float = 1.0, close_steps: int = 0, warm_start: int = 0) -> None:
    budgets = scaled_budgets(json.loads(Path(bench).read_text())["budgets"], budget_scale)
    plan = [it for it in stage_plan(budgets)]
    log(f"league plan: " + ", ".join(f"{i.phase}/{i.key}={i.target:,}" for i in plan))
    morning_a = next(i for i in plan if i.phase == "morning" and i.key == "A")
    easy_mark = max(1, round(EASY_INIT_FRACTION * morning_a.target))
    for item in plan:
        if item.phase not in only_phases:
            continue
        ck = run_dir / "ckpt" / item.key
        steps = ckpt_steps(ck)
        have = steps[-1][0] if steps else 0
        if have >= item.target:
            log(f"{item.phase}/{item.key}: done at {have:,}")
        else:
            if item.key == "A":
                cfg = make_stage("A", None, None)
                paths = RunPaths(ck, run_dir / "league" / "A", [], run_dir)
                marks = [easy_mark] if item.phase == "morning" else []
            else:
                if steps:
                    init = steps[-1][1]  # a resumed stage keeps its own checkpoint
                elif item.key == "easy":
                    hit = first_ckpt_at_or_after(run_dir / "ckpt" / "A", easy_mark)
                    if hit is None:
                        raise RuntimeError("Easy needs an early stage A checkpoint and none exists")
                    init = hit[1]
                else:
                    a_target = morning_a.target
                    hit = first_ckpt_at_or_after(run_dir / "ckpt" / "A", a_target)
                    if hit is None:
                        raise RuntimeError("stage B needs the finished morning stage A checkpoint and none exists")
                    init = hit[1]
                cfg = make_stage("B", item.key, init)
                paths = RunPaths(ck, run_dir / "league" / item.key, [run_dir / "league" / "A"], run_dir)
                marks = []
            log(f"== {item.phase}/{item.key}: {have:,} -> {item.target:,} steps ({cfg.level})")
            tr = Trainer(game, cfg, paths, procs=procs, envs_per_proc=envs_per_proc, seed=seed + zlib.crc32(f"{item.phase}/{item.key}".encode()) % 9973,
                         snapshot_every=snapshot_every, ckpt_every_s=ckpt_every_s, log=log, close_steps=close_steps, warm_start=warm_start)
            tr.run(item.target, resume=bool(steps), marks=marks)
        if item.key == "easy":
            data = write_levels(run_dir, item.phase, plan)
            log(f"wrote levels/{item.phase}.json: " + ", ".join(f"{k}@{v['step']:,}" for k, v in data["levels"].items()))


def parse_list(text: str, n: int, what: str) -> list[int]:
    vals = [int(float(x)) for x in text.split(",") if x.strip()]
    if len(vals) != n:
        raise SystemExit(f"train_realtime: {what} needs {n} comma-separated numbers, got {text!r}")
    return vals


def run_b2(game: str, run_dir: Path, *, champion_run: Path | None, a_steps: int = 0, a_seconds: float | None = None,
           b_steps: tuple[int, int, int], b_seconds: tuple[float, float, float], procs: int = 2, envs_per_proc: int = 64, seed: int = 0,
           snapshot_every: int = 1_000_000, gate_every: int = 2_000_000, gate_games: int = 48, close_steps: int = 0,
           warm_start: int = 0, log=_log) -> None:
    """Stage B again under the R15 env (v2 observation, free keep, fair bots, entropy anneal, scripted-bot gate).

    Hard, Medium and Easy start from a Champion that already exists: the finished stage A of `champion_run`
    (widened to the v2 observation and heads by build_agent; Easy from a Champion a quarter of the way through).
    With no `champion_run` (the arena, which has none yet) a short stage A runs first, here, under the v2 env.
    Every stage has a step target and a time cap, so each level gets time inside the job's maxHours; a stage that
    stops on its cap counts as done. Gate results land in <run>/gates, gated weights in <run>/gated and
    <run>/levels/gated.json; <run>/levels/b2.json lists the newest checkpoint of every level.
    """
    run_dir = Path(run_dir)
    done_dir = run_dir / "stage_done"
    done_dir.mkdir(parents=True, exist_ok=True)

    def finished(key: str) -> bool:
        return (done_dir / key).exists()

    if champion_run is None:
        a_dir, frozen_dir = run_dir / "ckpt" / "A", run_dir / "league" / "A"
        if not finished("A"):
            steps = ckpt_steps(a_dir)
            log(f"== b2/A: {steps[-1][0] if steps else 0:,} -> {a_steps:,} steps (champion)")
            tr = Trainer(game, make_stage("A", None, None), RunPaths(a_dir, frozen_dir, [], run_dir), procs=procs, envs_per_proc=envs_per_proc,
                         seed=seed + 1, snapshot_every=snapshot_every, log=log, close_steps=close_steps, warm_start=warm_start)
            tr.run(a_steps, resume=bool(steps), max_seconds=a_seconds)
            (done_dir / "A").write_text("done\n")
    else:
        a_dir, frozen_dir = Path(champion_run) / "ckpt" / "A", Path(champion_run) / "league" / "A"
    a_ckpts = ckpt_steps(a_dir)
    if not a_ckpts:
        raise RuntimeError(f"stage B needs a Champion checkpoint and {a_dir} has none")
    final_a = a_ckpts[-1]
    easy_init = first_ckpt_at_or_after(a_dir, max(1, round(EASY_INIT_FRACTION * final_a[0]))) or final_a
    for key, target, cap in zip(LEVEL_KEYS, b_steps, b_seconds):
        if finished(key):
            log(f"b2/{key}: done")
            continue
        ck = run_dir / "ckpt" / key
        steps = ckpt_steps(ck)
        have = steps[-1][0] if steps else 0
        init = steps[-1][1] if steps else (easy_init if key == "easy" else final_a)[1]
        cfg = make_stage("B", key, init)
        paths = RunPaths(ck, run_dir / "league" / key, [frozen_dir], run_dir)
        log(f"== b2/{key}: {have:,} -> {target:,} steps, cap {cap:.0f} s, init {Path(init).name}")
        tr = Trainer(game, cfg, paths, procs=procs, envs_per_proc=envs_per_proc, seed=seed + 2 + zlib.crc32(key.encode()) % 9973,
                     snapshot_every=snapshot_every, log=log, gate_every=gate_every, gate_games=gate_games)
        tr.run(target, resume=bool(steps), max_seconds=cap)
        (done_dir / key).write_text("done\n")
        write_b2_levels(run_dir)


B3_KEYS = ("A", "hard")


def b3_inits(champion_run: Path, b2_run: Path, keys: tuple[str, ...] = B3_KEYS) -> list[tuple[str, Path]]:
    """The starting checkpoints of the b3 retrain (R30), in order of `keys`: the newest Champion (stage A) of `champion_run` for "A", the newest checkpoint of that level in `b2_run` for the others."""
    out: list[tuple[str, Path]] = []
    for key in keys:
        if key != "A" and key not in LEVEL_KEYS:
            raise ValueError(f"b3 key must be A or one of {LEVEL_KEYS}, got {key!r}")
        ck = Path(champion_run) / "ckpt" / "A" if key == "A" else Path(b2_run) / "ckpt" / key
        steps = ckpt_steps(ck)
        if not steps:
            raise RuntimeError(f"b3 starts from the newest checkpoint in {ck} and there is none")
        out.append((key, steps[-1][1]))
    return out


def run_b3(game: str, run_dir: Path, *, champion_run: Path, b2_run: Path, steps: tuple[int, ...], seconds: tuple[float, ...], procs: int = 2,
           envs_per_proc: int = 64, seed: int = 0, snapshot_every: int = 1_000_000, gate_every: int = 2_000_000, gate_games: int = 48,
           keys: tuple[str, ...] = B3_KEYS, log=_log) -> None:
    """The R30 retrain: Champion first, then Hard, both against the league that now holds the exploit bots (zoner, throwloop, backwalk).

    Champion continues the newest stage A checkpoint of `champion_run` (the env is fighter-env-3 with a maximum separation; the
    observation is unchanged). Hard continues the newest b2 Hard. Both are gated at every `gate_every` steps against every bot that has
    a bar (gate.py), and a passing snapshot lands in <run>/gated/<level>/. Hard's frozen opponents are this run's own Champion snapshots,
    or the old Champion's when this run has none yet. Each stage has a step target and a time cap (it counts as done on either).
    `keys` names the stages and their order (the arena retrains hard then easy, the levels it publishes, against the fixed gate bots).
    """
    run_dir = Path(run_dir)
    done_dir = run_dir / "stage_done"
    done_dir.mkdir(parents=True, exist_ok=True)
    if not (len(keys) == len(steps) == len(seconds)):
        raise ValueError(f"b3 needs one step target and one time cap per stage {keys}")
    inits = dict(b3_inits(champion_run, b2_run, keys))
    for key, target, cap in zip(keys, steps, seconds):
        if (done_dir / key).exists():
            log(f"b3/{key}: done")
            continue
        ck = run_dir / "ckpt" / key
        have_steps = ckpt_steps(ck)
        have = have_steps[-1][0] if have_steps else 0
        if key == "A":
            cfg = make_stage("A", None, have_steps[-1][1] if have_steps else inits["A"])
            paths = RunPaths(ck, run_dir / "league" / "A", [Path(champion_run) / "league" / "A"], run_dir)
        else:
            cfg = make_stage("B", key, have_steps[-1][1] if have_steps else inits[key])
            own_a = run_dir / "league" / "A"
            paths = RunPaths(ck, run_dir / "league" / key, [own_a if L.load_snapshots(own_a, latest=1) else Path(champion_run) / "league" / "A"], run_dir)
        log(f"== b3/{key}: {have:,} -> {target:,} steps, cap {cap:.0f} s, init {Path(cfg.init).name}")
        tr = Trainer(game, cfg, paths, procs=procs, envs_per_proc=envs_per_proc, seed=seed + 3 + zlib.crc32(key.encode()) % 9973,
                     snapshot_every=snapshot_every, log=log, gate_every=gate_every, gate_games=gate_games, gate_stage_a=True)
        tr.run(target, resume=bool(have_steps), max_seconds=cap)
        (done_dir / key).write_text("done\n")
        levels = {}
        for k in keys:
            st = ckpt_steps(run_dir / "ckpt" / k)
            if st:
                levels["champion" if k == "A" else k] = {"path": str(st[-1][1]), "step": st[-1][0]}
        atomic_write_bytes(run_dir / "levels" / "b3.json", (json.dumps({"phase": "b3", "writtenAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "levels": levels}, indent=2) + "\n").encode())


def write_b2_levels(run_dir: Path) -> dict:
    """levels/b2.json: the newest checkpoint of every stage B level that has one."""
    levels = {}
    for key in LEVEL_KEYS:
        steps = ckpt_steps(run_dir / "ckpt" / key)
        if steps:
            levels[key] = {"path": str(steps[-1][1]), "step": steps[-1][0]}
    data = {"phase": "b2", "writtenAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "levels": levels}
    atomic_write_bytes(run_dir / "levels" / "b2.json", (json.dumps(data, indent=2) + "\n").encode())
    return data


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", default="fighter")
    ap.add_argument("--league", action="store_true", help="run every stage from the T7 budgets (the fighter-league job)")
    ap.add_argument("--bench", default="plan/bench/T7.json")
    ap.add_argument("--stage", choices=("A", "B"))
    ap.add_argument("--level", choices=LEVEL_KEYS)
    ap.add_argument("--steps", type=int)
    ap.add_argument("--init")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--run-dir", help="default: $TRAINER_RUN_DIR, else <common root>/runs/<game>-league")
    ap.add_argument("--ckpt-dir")
    ap.add_argument("--league-dir")
    ap.add_argument("--frozen-dir", action="append", default=[])
    ap.add_argument("--procs", type=int, default=2)
    ap.add_argument("--envs", type=int, default=64)
    ap.add_argument("--snapshot-every", type=int, default=1_000_000)
    ap.add_argument("--budget-scale", type=float, default=1.0, help="multiply every league step budget (arena: its env is slower than the fighter's)")
    ap.add_argument("--close-steps", type=int, default=0, help="stage A: run the close-range curriculum (arena) for this many total steps")
    ap.add_argument("--warm-start", type=int, default=0, help="stage A (arena): fit the fresh policy to this many decisions of the scripted bots first")
    ap.add_argument("--b2", action="store_true", help="R15: retrain stage B (hard, medium, easy) under the v2 env; see run_b2")
    ap.add_argument("--b3", action="store_true", help="R30: retrain Champion then Hard against the exploit bots; see run_b3")
    ap.add_argument("--b2-run", default="fighter-league-b2", help="--b3: the run whose newest Hard checkpoint Hard continues")
    ap.add_argument("--b3-keys", default="A,hard", help="--b3: the stages to retrain, in order (A is the Champion; hard, medium, easy continue --b2-run)")
    ap.add_argument("--b3-steps", default="20000000,20000000", help="--b3: one step target per stage in --b3-keys")
    ap.add_argument("--b3-seconds", default="5000,5000", help="--b3: one time cap in seconds per stage in --b3-keys")
    ap.add_argument("--champion-run", help="--b2/--b3: the run (name under runs/, or a path) whose finished stage A is the Champion; omit to train a short stage A first")
    ap.add_argument("--a-steps", type=int, default=0, help="--b2 without --champion-run: stage A steps")
    ap.add_argument("--a-seconds", type=float, help="--b2 without --champion-run: stage A time cap")
    ap.add_argument("--b-steps", default="30000000,20000000,15000000", help="--b2: hard,medium,easy step targets")
    ap.add_argument("--b-seconds", default="5400,4800,3600", help="--b2: hard,medium,easy time caps in seconds")
    ap.add_argument("--gate-every", type=int, default=2_000_000, help="stage B: steps between scripted-bot gate checks")
    ap.add_argument("--gate-games", type=int, default=48, help="stage B gate: matches per bot (arena: rounds are counted instead)")
    ap.add_argument("--max-seconds", type=float)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args(argv)
    game_spec(a.game)
    run_dir = Path(a.run_dir or os.environ.get("TRAINER_RUN_DIR") or runs_dir() / f"{a.game}-league")
    if a.b3:
        def _run(name: str) -> Path:
            q = Path(name)
            return q if q.is_absolute() else runs_dir() / q

        keys = tuple(k.strip() for k in a.b3_keys.split(","))
        run_b3(a.game, run_dir, champion_run=_run(a.champion_run or f"{a.game}-league"), b2_run=_run(a.b2_run), keys=keys,
               steps=tuple(parse_list(a.b3_steps, len(keys), "--b3-steps")), seconds=tuple(float(x) for x in parse_list(a.b3_seconds, len(keys), "--b3-seconds")),
               procs=a.procs, envs_per_proc=a.envs, seed=a.seed, snapshot_every=a.snapshot_every, gate_every=a.gate_every, gate_games=a.gate_games)
        return 0
    if a.b2:
        champion = Path(a.champion_run) if a.champion_run else None
        if champion is not None and not champion.is_absolute():
            champion = runs_dir() / champion  # a bare run name such as fighter-league lives in the common root's runs/
        run_b2(a.game, run_dir, champion_run=champion, a_steps=a.a_steps, a_seconds=a.a_seconds,
               b_steps=tuple(parse_list(a.b_steps, 3, "--b-steps")), b_seconds=tuple(float(x) for x in parse_list(a.b_seconds, 3, "--b-seconds")),
               procs=a.procs, envs_per_proc=a.envs, seed=a.seed, snapshot_every=a.snapshot_every, gate_every=a.gate_every,
               gate_games=a.gate_games, close_steps=a.close_steps, warm_start=a.warm_start)
        return 0
    if a.league:
        run_league(a.game, Path(a.bench), run_dir, procs=a.procs, envs_per_proc=a.envs, seed=a.seed, snapshot_every=a.snapshot_every,
                   budget_scale=a.budget_scale, close_steps=a.close_steps, warm_start=a.warm_start)
        return 0
    if not a.stage or not a.steps:
        ap.error("--stage and --steps are required (or use --league)")
    cfg = make_stage(a.stage, a.level, a.init)
    key = "A" if a.stage == "A" else a.level
    paths = RunPaths(Path(a.ckpt_dir) if a.ckpt_dir else run_dir / "ckpt" / key,
                     Path(a.league_dir) if a.league_dir else run_dir / "league" / key,
                     [Path(d) for d in a.frozen_dir], run_dir)
    Trainer(a.game, cfg, paths, procs=a.procs, envs_per_proc=a.envs, seed=a.seed, snapshot_every=a.snapshot_every,
            close_steps=a.close_steps, warm_start=a.warm_start, gate_every=a.gate_every, gate_games=a.gate_games).run(
        a.steps, resume=a.resume, max_seconds=a.max_seconds)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
