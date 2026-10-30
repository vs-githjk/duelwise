"""Job specs and per-job state files under <common root>/runs/<job>/.

Files: spec.json (as enqueued, cwd filled in), state.json (written only by the supervisor after
enqueue), STOP (a stop request), exit (exit code of the last attempt), heartbeat (touched by the
job), train.log. A job spec is `training/jobs/<job>.json`."""

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .paths import TRAINING_DIR, atomic_write_bytes

JOBS_DIR = TRAINING_DIR / "jobs"
TERMINAL = {"DONE", "FAILED", "STOPPED", "TIMEOUT"}


@dataclass
class JobSpec:
    name: str
    cmd: list[str]
    cpu_slots: int = 1
    mps: bool = False
    max_hours: float | None = None
    after: list[str] = field(default_factory=list)
    resume_arg: str | None = "--resume"
    checkpoint_dir: str | None = None
    cwd: str | None = None
    milestones: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "name": self.name,
            "cmd": list(self.cmd),
            "cpuSlots": self.cpu_slots,
            "mps": self.mps,
            "maxHours": self.max_hours,
            "after": list(self.after),
            "resumeArg": self.resume_arg,
            "checkpointDir": self.checkpoint_dir,
            "cwd": self.cwd,
            "milestones": dict(self.milestones),
        }

    @staticmethod
    def from_json(d: dict) -> "JobSpec":
        name = d.get("name")
        cmd = d.get("cmd")
        if not isinstance(name, str) or not name or "/" in name or name.startswith("."):
            raise ValueError(f"job name must be a plain non-empty string, got {name!r}")
        if not isinstance(cmd, list) or not cmd or not all(isinstance(c, str) for c in cmd):
            raise ValueError(f"job {name}: cmd must be a non-empty list of strings")
        slots = d.get("cpuSlots", 1)
        if not isinstance(slots, int) or slots < 0:
            raise ValueError(f"job {name}: cpuSlots must be an integer >= 0")
        max_hours = d.get("maxHours")
        if max_hours is not None and (isinstance(max_hours, bool) or not isinstance(max_hours, (int, float)) or not max_hours > 0):
            raise ValueError(f"job {name}: maxHours must be a positive number or null, got {max_hours!r}")
        after = d.get("after", [])
        if not isinstance(after, list) or not all(isinstance(a, str) for a in after):
            raise ValueError(f"job {name}: after must be a list of job names")
        mps = d.get("mps", False)
        if not isinstance(mps, bool):
            raise ValueError(f"job {name}: mps must be true or false, got {mps!r}")
        return JobSpec(
            name=name,
            cmd=cmd,
            cpu_slots=slots,
            mps=mps,
            max_hours=max_hours,
            after=list(after),
            resume_arg=d.get("resumeArg", "--resume"),
            checkpoint_dir=d.get("checkpointDir"),
            cwd=d.get("cwd"),
            milestones=dict(d.get("milestones", {})),
        )


def load_spec(name_or_path: str, jobs_dir: Path = JOBS_DIR) -> JobSpec:
    p = Path(name_or_path)
    if not (p.suffix == ".json" and p.exists()):
        p = jobs_dir / f"{name_or_path}.json"
    if not p.exists():
        raise FileNotFoundError(f"no job spec {name_or_path!r} (looked for {p})")
    return JobSpec.from_json(json.loads(p.read_text()))


def job_dir(runs: Path, name: str) -> Path:
    return runs / name


def write_json(path: Path, data: dict) -> None:
    atomic_write_bytes(path, (json.dumps(data, indent=2, sort_keys=True) + "\n").encode())


def read_state(runs: Path, name: str) -> dict:
    return json.loads((job_dir(runs, name) / "state.json").read_text())


def enqueue(runs: Path, spec: JobSpec) -> None:
    """Queue a job for the supervisor. A finished job may be queued again; a live one may not."""
    d = job_dir(runs, spec.name)
    sp = d / "state.json"
    if sp.exists():
        old = json.loads(sp.read_text())
        if old.get("state") not in TERMINAL:
            raise ValueError(f"job {spec.name} is already {old.get('state')}; stop it first")
    d.mkdir(parents=True, exist_ok=True)
    for stale in ("STOP", "exit"):
        (d / stale).unlink(missing_ok=True)
    write_json(d / "spec.json", spec.to_json())
    write_json(
        sp,
        {"name": spec.name, "state": "QUEUED", "pid": None, "restarts": 0, "enqueuedAt": time.time(),
         "firstStartedAt": None, "attemptStartedAt": None, "lastExit": None, "reason": None},
    )


def request_stop(runs: Path, name: str) -> None:
    d = job_dir(runs, name)
    if not (d / "state.json").exists():
        raise FileNotFoundError(f"no such job {name}")
    (d / "STOP").write_text("stop\n")


def heartbeat() -> None:
    """Called by a running job to show it is alive (the supervisor restarts jobs silent for 10 minutes)."""
    path = os.environ.get("TRAINER_HEARTBEAT")
    if path:
        Path(path).touch()


def _canary(argv: list[str]) -> int:
    """The canary: a 3 minute tiny training run that checkpoints every 30 s and resumes after a crash.
    It proves the supervisor, checkpoints and heartbeat survive without any builder session."""
    import torch

    from .checkpoint import load_latest, save_checkpoint
    from .paths import resolve_runs_path, runs_dir

    ap = argparse.ArgumentParser()
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--seconds", type=int, default=180)
    ap.add_argument("--every", type=int, default=30)
    ap.add_argument("--ckpt-dir", default=os.environ.get("TRAINER_CKPT_DIR"))
    a = ap.parse_args(argv)
    ckpt = Path(a.ckpt_dir) if a.ckpt_dir else resolve_runs_path("runs/canary/ckpt", runs_dir())
    torch.manual_seed(0)
    model = torch.nn.Linear(8, 1)
    opt = torch.optim.SGD(model.parameters(), lr=0.01, momentum=0.9)
    step = 0
    if a.resume:
        info = load_latest(ckpt, model, opt)
        if info:
            step = info["step"]
            print(f"canary: resumed at step {step}", flush=True)
    while step < a.seconds:
        g = torch.Generator().manual_seed(step)
        x = torch.randn(32, 8, generator=g)
        loss = ((model(x).squeeze(1) - x.sum(1)) ** 2).mean()
        opt.zero_grad()
        loss.backward()
        opt.step()
        step += 1
        heartbeat()
        if step % a.every == 0 or step == a.seconds:
            save_checkpoint(ckpt, step, model, opt, extra={"loss": loss.item()})
            print(f"canary: step {step} loss {loss.item():.4f}", flush=True)
        time.sleep(1.0)
    print("canary: done", flush=True)
    return 0


if __name__ == "__main__":
    import sys

    if len(sys.argv) >= 2 and sys.argv[1] == "canary":
        raise SystemExit(_canary(sys.argv[2:]))
    raise SystemExit("usage: python -m trainer.jobs canary [--resume]")
