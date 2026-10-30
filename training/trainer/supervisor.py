"""The one machine-wide training supervisor.

Detached and niced; polls every 10 s; keeps CPU slots and the MPS job count inside budget.json;
restarts a crashed or silent job with its resume argument (at most 3 times); enforces maxHours;
writes runs/status.json. State lives in files under runs/<job>/, so a new supervisor adopts jobs
that a dead one started."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

from .budget import DEFAULT_PATH, Budget, load_budget
from .jobs import TERMINAL, JobSpec, job_dir, read_state, write_json
from .paths import resolve_runs_path, runs_dir

MAX_RESTARTS = 3
STALE_SECONDS = 600.0
TERM_GRACE = 10.0

_WRAPPER = 'n="$1"; ef="$2"; shift 2; nice -n "$n" "$@"; echo $? > "$ef.tmp" && mv "$ef.tmp" "$ef"'


def pid_command(pid: int | None) -> str:
    """The full command line of `pid` ('' when it is gone)."""
    if not pid:
        return ""
    p = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True)
    return p.stdout.strip() if p.returncode == 0 else ""


def pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    # A finished child that nobody has waited for still answers kill(pid, 0): ask ps for its state.
    p = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return p.returncode == 0 and bool(p.stdout.strip()) and not p.stdout.strip().startswith("Z")


def kill_group(pid: int, grace: float = TERM_GRACE) -> None:
    """SIGTERM the job's process group, SIGKILL whatever is left after `grace` seconds."""
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    end = time.time() + grace
    while time.time() < end:
        try:
            os.killpg(pid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            return  # macOS reports a group of only zombies this way: everything has exited
        time.sleep(0.1)
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def read_status(runs: Path) -> dict:
    return json.loads((runs / "status.json").read_text())


class Supervisor:
    def __init__(
        self,
        runs: Path,
        budget: Budget,
        poll: float = 10.0,
        stale_s: float = STALE_SECONDS,
        max_restarts: int = MAX_RESTARTS,
        clock: Callable[[], float] = time.time,
    ):
        self.runs = Path(runs)
        self.budget = budget
        self.poll = poll
        self.stale_s = stale_s
        self.max_restarts = max_restarts
        self.clock = clock
        self.procs: dict[str, subprocess.Popen] = {}
        self.runs.mkdir(parents=True, exist_ok=True)

    # ---- state helpers -------------------------------------------------
    def _names(self) -> list[str]:
        return sorted(p.parent.name for p in self.runs.glob("*/state.json"))

    def _load(self, name: str) -> tuple[JobSpec, dict] | None:
        try:
            spec = JobSpec.from_json(json.loads((job_dir(self.runs, name) / "spec.json").read_text()))
            return spec, read_state(self.runs, name)
        except (OSError, ValueError, KeyError):
            return None  # being written right now, or damaged: look again next tick

    def _save(self, name: str, st: dict) -> None:
        write_json(job_dir(self.runs, name) / "state.json", st)

    def _stop_requested(self, name: str) -> bool:
        return (job_dir(self.runs, name) / "STOP").exists()

    # ---- one pass ------------------------------------------------------
    def tick(self) -> None:
        now = self.clock()
        loaded = {n: v for n in self._names() if (v := self._load(n))}
        for name, (spec, st) in loaded.items():
            if st["state"] == "RUNNING":
                self._isolated(name, self._check_running, name, spec, st, now)
        for name, (spec, st) in sorted(loaded.items(), key=lambda kv: kv[1][1].get("enqueuedAt", 0)):
            if st["state"] == "QUEUED":
                self._isolated(name, self._try_start, name, spec, st, loaded, now)
        self._write_status(now)

    def _isolated(self, name: str, fn: Callable, *args) -> None:
        """One broken job must not stall the others: log it and carry on."""
        try:
            fn(*args)
        except Exception as e:
            print(f"supervisor: job {name} failed this tick: {type(e).__name__}: {e}", file=sys.stderr, flush=True)

    def _exit_code(self, name: str) -> int | None:
        try:
            return int((job_dir(self.runs, name) / "exit").read_text().strip())
        except (OSError, ValueError):
            return None

    def _alive(self, name: str, st: dict) -> bool:
        proc = self.procs.get(name)
        if proc is not None:
            return proc.poll() is None
        return self._adopted_is_ours(name, st)

    def _adopted_is_ours(self, name: str, st: dict) -> bool:
        """A job a dead supervisor started is identified by its wrapper's command line, which carries
        this job's exit-file path. A recycled pid (after a reboot) belonging to anything else is not ours."""
        pid = st.get("pid")
        return pid_alive(pid) and str(job_dir(self.runs, name) / "exit") in pid_command(pid)

    def _kill(self, name: str, st: dict, grace: float = TERM_GRACE) -> None:
        """Kill a job's process group, but only a process this supervisor started or can prove is the job's."""
        pid = st.get("pid")
        if pid and (name in self.procs or self._adopted_is_ours(name, st)):
            kill_group(pid, grace)

    def _check_running(self, name: str, spec: JobSpec, st: dict, now: float) -> None:
        if self._stop_requested(name):
            self._kill(name, st)
            self._reap(name)
            self._finish(name, st, "STOPPED", "stop requested")
            return
        if self._alive(name, st):
            if spec.max_hours is not None and now - st["firstStartedAt"] > spec.max_hours * 3600:
                self._kill(name, st)
                self._reap(name)
                self._finish(name, st, "TIMEOUT", f"exceeded maxHours {spec.max_hours}")
                return
            hb = job_dir(self.runs, name) / "heartbeat"
            last = max(st["attemptStartedAt"], hb.stat().st_mtime if hb.exists() else 0)
            if now - last > self.stale_s:
                self._kill(name, st, grace=0.5)
                self._reap(name)
                self._crashed(name, spec, st, f"no heartbeat for {int(now - last)} s", now)
            return
        self._reap(name)
        code = self._exit_code(name)
        if code == 0:
            self._finish(name, st, "DONE", None, lastExit=0)
        else:
            self._crashed(name, spec, st, f"exit {code}" if code is not None else "killed (no exit code)", now, code)

    def _reap(self, name: str) -> None:
        proc = self.procs.pop(name, None)
        if proc is not None:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass

    def _finish(self, name: str, st: dict, state: str, reason: str | None, **extra) -> None:
        st.update(state=state, reason=reason, pid=None, finishedAt=self.clock(), **extra)
        self._save(name, st)

    def _crashed(self, name: str, spec: JobSpec, st: dict, why: str, now: float, code: int | None = None) -> None:
        if st["restarts"] >= self.max_restarts:
            self._finish(name, st, "FAILED", f"{why}; gave up after {st['restarts']} restarts", lastExit=code)
            return
        st["restarts"] += 1
        st["lastExit"] = code
        st["reason"] = f"restarted after: {why}"
        self._launch(name, spec, st, now, resume=True)

    def _try_start(self, name: str, spec: JobSpec, st: dict, loaded: dict, now: float) -> None:
        if self._stop_requested(name):
            self._finish(name, st, "STOPPED", "stop requested before start")
            return
        if spec.cpu_slots > self.budget.cpu_slots or (spec.mps and self.budget.mps_jobs < 1):
            self._finish(name, st, "FAILED", f"asks for {spec.cpu_slots} CPU slots (mps={spec.mps}) but the budget is {self.budget.cpu_slots} (mps jobs {self.budget.mps_jobs})")
            return
        for dep in spec.after:
            other = loaded.get(dep)
            if other is None:
                return  # not enqueued yet: wait
            if other[1]["state"] in TERMINAL - {"DONE"}:
                self._finish(name, st, "FAILED", f"after {dep}, which ended {other[1]['state']}")
                return
            if other[1]["state"] != "DONE":
                return
        used = sum(s.cpu_slots for s, t in self._running(loaded))
        mps_used = sum(1 for s, t in self._running(loaded) if s.mps)
        if used + spec.cpu_slots > self.budget.cpu_slots or (spec.mps and mps_used >= self.budget.mps_jobs):
            return
        st["firstStartedAt"] = now
        self._launch(name, spec, st, now, resume=False)

    def _running(self, loaded: dict):
        # `loaded` holds the dicts mutated in place by _launch and _finish, so this is current.
        return [(s, t) for s, t in loaded.values() if t["state"] == "RUNNING"]

    def _nice_delta(self) -> int:
        """`nice -n` is relative: take the supervisor's own niceness into account so jobs run at budget.nice."""
        return max(0, self.budget.nice - os.getpriority(os.PRIO_PROCESS, 0))

    def _launch(self, name: str, spec: JobSpec, st: dict, now: float, resume: bool) -> None:
        d = job_dir(self.runs, name)
        cwd = Path(spec.cwd) if spec.cwd else self.runs.parent
        if not cwd.is_dir():
            self._finish(name, st, "FAILED", f"cwd does not exist: {cwd}")
            return
        cmd = list(spec.cmd) + ([spec.resume_arg] if resume and spec.resume_arg else [])
        (d / "exit").unlink(missing_ok=True)
        env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}  # the job's own scripts/py sets it
        env.update(TRAINER_JOB=name, TRAINER_RUN_DIR=str(d), TRAINER_HEARTBEAT=str(d / "heartbeat"))
        if spec.checkpoint_dir:
            env["TRAINER_CKPT_DIR"] = str(resolve_runs_path(spec.checkpoint_dir, self.runs))
        log = open(d / "train.log", "ab")
        try:
            proc = subprocess.Popen(
                ["/bin/sh", "-c", _WRAPPER, "sh", str(self._nice_delta()), str(d / "exit"), *cmd],
                cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
            )
        except OSError as e:
            self._finish(name, st, "FAILED", f"could not start: {e}")
            return
        finally:
            log.close()
        self.procs[name] = proc
        st.update(state="RUNNING", pid=proc.pid, attemptStartedAt=now, cmd=cmd)
        self._save(name, st)

    # ---- status --------------------------------------------------------
    def _write_status(self, now: float) -> None:
        jobs, used, mps_used = {}, 0, 0
        for name in self._names():
            v = self._load(name)
            if not v:
                continue
            spec, st = v
            hb = job_dir(self.runs, name) / "heartbeat"
            jobs[name] = {
                "state": st["state"], "pid": st.get("pid"), "restarts": st["restarts"], "cpuSlots": spec.cpu_slots,
                "mps": spec.mps, "cwd": spec.cwd, "after": spec.after, "lastExit": st.get("lastExit"), "reason": st.get("reason"),
                "startedAt": st.get("firstStartedAt"),
                "heartbeatAgeS": round(now - hb.stat().st_mtime, 1) if hb.exists() and st["state"] == "RUNNING" else None,
            }
            if st["state"] == "RUNNING":
                used += spec.cpu_slots
                mps_used += 1 if spec.mps else 0
        write_json(self.runs / "status.json", {
            "supervisorPid": os.getpid(), "updatedAt": now, "budget": self.budget.as_json(),
            "slotsUsed": used, "mpsUsed": mps_used, "jobs": jobs,
        })

    def run_forever(self, should_stop: Callable[[], bool]) -> None:
        while not should_stop():
            try:
                self.tick()
            except Exception as e:  # never die on one bad job; say why and look again
                print(f"supervisor tick failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            time.sleep(self.poll)


def lock_path(runs: Path) -> Path:
    return runs / "supervisor.lock"


def supervisor_running(runs: Path) -> bool:
    """True when some process holds the supervisor lock."""
    runs.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path(runs), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return True
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="trainer.supervisor")
    ap.add_argument("--runs-dir", required=True)
    ap.add_argument("--budget", default=str(DEFAULT_PATH))
    ap.add_argument("--poll", type=float, default=10.0)
    a = ap.parse_args(argv)
    runs = Path(a.runs_dir)
    runs.mkdir(parents=True, exist_ok=True)
    lock_fd = os.open(lock_path(runs), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("supervisor already running", file=sys.stderr)
        return 1
    (runs / "supervisor.pid").write_text(f"{os.getpid()}\n")
    stop = {"now": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.update(now=True))
    signal.signal(signal.SIGINT, lambda *_: stop.update(now=True))
    sup = Supervisor(runs, load_budget(a.budget), poll=a.poll)
    print(f"supervisor up pid={os.getpid()} runs={runs}", flush=True)
    sup.run_forever(lambda: stop["now"])
    (runs / "supervisor.pid").unlink(missing_ok=True)
    print("supervisor down (running jobs keep running)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
