"""`bun run train -- up|status|enqueue <job>|stop <job>|down` (and the export, measure, retrain entry points).

All commands act on the one machine-wide supervisor and runs/ directory in the common root."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from .budget import DEFAULT_PATH
from .jobs import enqueue, job_dir, load_spec, read_state, request_stop
from .paths import TRAINING_DIR, runs_dir, worktree_root
from .supervisor import pid_alive, read_status, supervisor_running


def cmd_up(a: argparse.Namespace) -> int:
    runs = runs_dir()
    runs.mkdir(parents=True, exist_ok=True)
    if supervisor_running(runs):
        pid = (runs / "supervisor.pid").read_text().strip() if (runs / "supervisor.pid").exists() else "?"
        print(f"supervisor already running (pid {pid}), runs dir {runs}")
        return 0
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONPATH"] = str(TRAINING_DIR)
    log = open(runs / "supervisor.log", "ab")
    cmd = [sys.executable, "-m", "trainer.supervisor", "--runs-dir", str(runs), "--budget", str(Path(a.budget).resolve()), "--poll", str(a.poll)]
    subprocess.Popen(cmd, cwd=runs.parent, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                     start_new_session=True, preexec_fn=lambda: os.nice(10))
    log.close()
    end = time.time() + 15
    while time.time() < end:
        if supervisor_running(runs) and (runs / "supervisor.pid").exists():
            print(f"supervisor started (pid {(runs / 'supervisor.pid').read_text().strip()}), runs dir {runs}")
            return 0
        time.sleep(0.1)
    print(f"supervisor did not start; see {runs / 'supervisor.log'}", file=sys.stderr)
    return 1


def cmd_status(a: argparse.Namespace) -> int:
    runs = runs_dir()
    up = supervisor_running(runs)
    pid = (runs / "supervisor.pid").read_text().strip() if (runs / "supervisor.pid").exists() else "?"
    print(f"supervisor: {'up (pid ' + pid + ')' if up else 'DOWN'}   runs dir: {runs}")
    try:
        s = read_status(runs)
    except (OSError, ValueError):
        print("no status.json yet")
        return 0 if up else 1
    b = s["budget"]
    print(f"slots: {s['slotsUsed']}/{b['cpuSlots']} cpu, {s['mpsUsed']}/{b['mpsJobs']} mps   updated {time.strftime('%H:%M:%S', time.localtime(s['updatedAt']))}")
    if not s["jobs"]:
        print("no jobs")
    for name, j in s["jobs"].items():
        hb = f" hb {j['heartbeatAgeS']}s" if j.get("heartbeatAgeS") is not None else ""
        print(f"  {name:<16} {j['state']:<8} pid={j['pid']} slots={j['cpuSlots']}{' mps' if j['mps'] else ''} restarts={j['restarts']}{hb}" + (f"  ({j['reason']})" if j.get("reason") else ""))
    return 0


def cmd_enqueue(a: argparse.Namespace) -> int:
    runs = runs_dir()
    spec = load_spec(a.job)
    spec.cwd = str(worktree_root())
    enqueue(runs, spec)
    print(f"enqueued {spec.name} (cwd {spec.cwd})")
    if not supervisor_running(runs):
        print("note: the supervisor is not running; start it with `bun run train -- up`", file=sys.stderr)
    return 0


def cmd_stop(a: argparse.Namespace) -> int:
    runs = runs_dir()
    request_stop(runs, a.job)
    print(f"stop requested for {a.job}")
    if not supervisor_running(runs):
        print("note: the supervisor is not running; the request is applied when it starts", file=sys.stderr)
    return 0


def cmd_down(a: argparse.Namespace) -> int:
    runs = runs_dir()
    pf = runs / "supervisor.pid"
    if not supervisor_running(runs) or not pf.exists():
        print("supervisor is not running")
        return 0
    pid = int(pf.read_text())
    os.kill(pid, 15)
    end = time.time() + 20
    while time.time() < end and pid_alive(pid):
        time.sleep(0.1)
    print("supervisor stopped; jobs it started keep running and are adopted by the next `up`")
    return 0 if not pid_alive(pid) else 1


def _pending(task: str):
    def run(a: argparse.Namespace) -> int:
        print(f"`{a.cmd}` is not implemented yet: it arrives with {task}.", file=sys.stderr)
        return 2

    return run


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="trainer.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    up = sub.add_parser("up", help="start the supervisor (or attach to the running one)")
    up.add_argument("--budget", default=str(DEFAULT_PATH))
    up.add_argument("--poll", type=float, default=10.0)
    up.set_defaults(fn=cmd_up)
    sub.add_parser("status", help="supervisor and job states").set_defaults(fn=cmd_status)
    en = sub.add_parser("enqueue", help="queue a job spec (name from training/jobs or a .json path)")
    en.add_argument("job")
    en.set_defaults(fn=cmd_enqueue)
    st = sub.add_parser("stop", help="stop a job")
    st.add_argument("job")
    st.set_defaults(fn=cmd_stop)
    sub.add_parser("down", help="stop the supervisor (jobs keep running)").set_defaults(fn=cmd_down)
    for name, task in (("export", "the game trainers (T5, T12, T23, T27)"), ("measure", "the measurement tasks (T23, T25, T26, T27)")):
        sub.add_parser(name).set_defaults(fn=_pending(task))
    from .retrain import add_arguments, run_cli

    rt = sub.add_parser("retrain", help="train a challenger on filtered human matches and gate it against the champion")
    add_arguments(rt)
    rt.set_defaults(fn=run_cli)
    if argv and argv[0] == "retrain":  # `bun run retrain -- --game four` may pass a literal `--` through
        argv = [x for i, x in enumerate(argv) if not (x == "--" and i == 1)]
    a, _ = ap.parse_known_args(argv) if argv and argv[0] in ("export", "measure") else (ap.parse_args(argv), None)
    try:
        return a.fn(a)
    except (FileNotFoundError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
