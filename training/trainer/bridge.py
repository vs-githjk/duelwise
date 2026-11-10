"""Python side of the Bun env bridge (packages/core/src/bridge).

Frames: u32 LE total length (bytes after this field), u32 LE header length, JSON header, raw payload.
Action layout for step: int32 (n, 2 seats, actionDims). Reward is from seat 0's view.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable

import numpy as np

from .paths import worktree_root

MAX_FRAME = 256 * 1024 * 1024


class BridgeError(RuntimeError):
    pass


def find_bun() -> str:
    found = shutil.which("bun")
    if found:
        return found
    fallback = Path.home() / ".bun" / "bin" / "bun"
    if fallback.exists():
        return str(fallback)
    raise BridgeError("bun not found on PATH")


def _main_ts() -> Path:
    return worktree_root(Path(__file__).resolve().parent) / "packages" / "core" / "src" / "bridge" / "main.ts"


def write_frame(stream, header: dict, payload: bytes = b"") -> None:
    hb = json.dumps(header).encode("utf-8")
    stream.write(struct.pack("<II", 4 + len(hb) + len(payload), len(hb)) + hb + payload)
    stream.flush()


def _read_exact(stream, n: int) -> bytes:
    chunks, got = [], 0
    while got < n:
        chunk = stream.read(n - got)
        if not chunk:
            raise EOFError("bridge closed the pipe")
        chunks.append(chunk)
        got += len(chunk)
    return b"".join(chunks)


def read_frame(stream) -> tuple[dict, bytes]:
    total = struct.unpack("<I", _read_exact(stream, 4))[0]
    if total < 4 or total > MAX_FRAME:
        raise BridgeError(f"bad frame length {total}")
    body = _read_exact(stream, total)
    hl = struct.unpack("<I", body[:4])[0]
    if hl > total - 4:
        raise BridgeError("header length exceeds frame")
    return json.loads(body[4 : 4 + hl]), body[4 + hl :]


class _Proc:
    """A child process spoken to in frames; its stderr goes to a temp file quoted in errors."""

    def __init__(self, cmd: list[str], cwd: Path):
        self._err = tempfile.TemporaryFile()
        self._proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._err, cwd=cwd, bufsize=0
        )
        self._stdin = self._proc.stdin
        self._stdout = self._proc.stdout

    def _stderr_tail(self) -> str:
        try:
            self._err.seek(0)
            return self._err.read().decode("utf-8", "replace").strip()[-2000:]
        except (OSError, ValueError):
            return ""

    def send(self, header: dict, payload: bytes = b"") -> None:
        try:
            write_frame(self._stdin, header, payload)
        except (BrokenPipeError, OSError) as e:
            raise BridgeError(f"bridge process is gone: {e}: {self._stderr_tail()}") from e

    def recv(self) -> tuple[dict, bytes]:
        try:
            h, p = read_frame(self._stdout)
        except EOFError as e:
            code = self._proc.wait(timeout=5)
            raise BridgeError(f"bridge process exited with code {code}: {self._stderr_tail()}") from e
        if h.get("type") == "error":
            raise BridgeError(h.get("message", "bridge error"))
        return h, p

    def close(self) -> None:
        proc = self._proc
        if proc.poll() is None:
            try:
                write_frame(self._stdin, {"type": "close"})
            except (BrokenPipeError, OSError):
                pass
        for f in (self._stdin, self._stdout):
            try:
                f.close()
            except OSError:
                pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        self._err.close()


class BridgeEnv:
    """A batch of n auto-resetting envs served by `bun packages/core/src/bridge/main.ts`."""

    def __init__(self, game: str, n: int, seed: int = 0, level: str | None = None, *, champion_bot_delay: int = 0, goal_shaping: float = 0.0):
        """`champion_bot_delay` (frames) and `goal_shaping` are training-only env options (puck); the gate and eval never pass them."""
        self.game, self.n, self.seed = game, n, seed
        cmd = [find_bun(), str(_main_ts()), "--game", game, "--n", str(n), "--seed", str(seed)]
        if level:
            cmd += ["--level", level]
        if champion_bot_delay:
            cmd += ["--champion-bot-delay", str(int(champion_bot_delay))]
        if goal_shaping:
            cmd += ["--goal-shaping", repr(float(goal_shaping))]
        self.cmd = cmd
        self._p = _Proc(cmd, worktree_root(Path(__file__).resolve().parent))
        self._proc = self._p._proc
        self._closed = False
        try:
            self._p.send({"type": "hello"})
            h, _ = self._p.recv()
        except BridgeError:
            self.close()
            raise
        self.obs_shape = tuple(h["obsShape"])
        self.action_dims = int(h["actionDims"])
        self.version = h["version"]
        self._obs_size = int(np.prod(self.obs_shape))

    def reset(self, seeds: list[int] | None = None) -> np.ndarray:
        seeds = list(seeds) if seeds is not None else [self.seed + i for i in range(self.n)]
        self._p.send({"type": "reset", "seeds": seeds})
        _, payload = self._p.recv()
        return np.frombuffer(payload, dtype=np.float32).reshape((self.n, *self.obs_shape)).copy()

    def step(self, actions: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[dict]]:
        actions = np.asarray(actions)
        want = (self.n, 2, self.action_dims)
        if actions.shape != want:
            raise BridgeError(f"actions must have shape {want}, got {actions.shape}")
        self._p.send({"type": "step"}, np.ascontiguousarray(actions, dtype="<i4").tobytes())
        h, payload = self._p.recv()
        o = self.n * self._obs_size * 4
        obs = np.frombuffer(payload, dtype=np.float32, count=self.n * self._obs_size).reshape((self.n, *self.obs_shape)).copy()
        reward = np.frombuffer(payload, dtype=np.float32, count=self.n, offset=o).copy()
        done = np.frombuffer(payload, dtype=np.uint8, count=self.n, offset=o + self.n * 4).astype(bool)
        return obs, reward, done, h["infos"]

    def close(self) -> None:
        if not getattr(self, "_closed", True):
            self._closed = True
            self._p.close()

    def __enter__(self) -> "BridgeEnv":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass


class SelfPlayDriver:
    """Drives a self-play host (T12): the host sends `eval_request` (float32 batch, header n and
    obsSize), we answer `eval_response` (float32 policy (n, A) then float32 value (n,)) from
    `evaluate_fn(batch) -> (policy, value)`, until the host sends `games`."""

    def __init__(
        self,
        game: str,
        n_games: int,
        sims: int,
        evaluate_fn: Callable[[np.ndarray], tuple[np.ndarray, np.ndarray]],
        cmd: list[str] | None = None,
        seed: int = 0,
        level: str | None = None,
        on_start: Callable[[subprocess.Popen], None] | None = None,
    ):
        self.on_start = on_start
        self.game, self.n_games, self.sims, self.evaluate_fn = game, n_games, sims, evaluate_fn
        if cmd is None:
            cmd = [find_bun(), str(_main_ts()), "--game", game, "--n", str(n_games), "--seed", str(seed), "--mode", "selfplay", "--sims", str(sims)]
            if level:
                cmd += ["--level", level]
        self._cmd = cmd
        # Games received so far. With `--flush K` in the command the host sends partial `games` frames, so when
        # the bridge dies mid-run the caller still has every game finished before it (T12b).
        self.collected: list[dict] = []
        self.proc: subprocess.Popen | None = None

    def run(self) -> list[dict]:
        self.collected = []
        p = _Proc(self._cmd, worktree_root(Path(__file__).resolve().parent))
        self.proc = p._proc
        if self.on_start:
            self.on_start(p._proc)
        try:
            while True:
                h, payload = p.recv()
                kind = h.get("type")
                if kind == "games":
                    self.collected.extend(h["games"])
                    if h.get("partial"):
                        continue
                    return list(self.collected)
                if kind != "eval_request":
                    raise BridgeError(f"unexpected message {kind!r} from the self-play host")
                n, size = int(h["n"]), int(h["obsSize"])
                batch = np.frombuffer(payload, dtype=np.float32).reshape(n, size)
                policy, value = self.evaluate_fn(batch)
                policy = np.ascontiguousarray(policy, dtype="<f4")
                value = np.ascontiguousarray(value, dtype="<f4").reshape(n)
                p.send({"type": "eval_response", "n": n}, policy.tobytes() + value.tobytes())
        finally:
            p.close()
