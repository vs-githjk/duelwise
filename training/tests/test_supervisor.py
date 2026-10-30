import json
import os
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from trainer.budget import Budget, load_budget
from trainer.jobs import JobSpec, enqueue, read_state, request_stop
from trainer.supervisor import Supervisor, read_status

TRAINING = Path(__file__).resolve().parents[1]

DUMMY = textwrap.dedent(
    """
    import os, sys, time
    from pathlib import Path
    run = Path(os.environ["TRAINER_RUN_DIR"])
    args = sys.argv[1:]
    with open(run / "attempts.log", "a") as f:
        f.write(" ".join(args) + "|" + os.getcwd() + "\\n")
    resume = "--resume" in args
    mode = args[0]
    if mode == "fail":
        sys.exit(3)
    if mode == "hang" and not resume:
        time.sleep(600)
    dur = 0.5 if resume else (float(args[0]) if mode not in ("hang",) else 0.5)
    end = time.time() + dur
    while time.time() < end:
        (run / "heartbeat").touch()
        time.sleep(0.1)
    """
)


@pytest.fixture
def env(tmp_path):
    runs = tmp_path / "runs"
    runs.mkdir()
    script = tmp_path / "dummy.py"
    script.write_text(DUMMY)
    budget = Budget(cpu_slots=5, mps_jobs=1, nice=10)

    def sup(**kw):
        return Supervisor(runs, kw.pop("budget", budget), poll=0.05, **kw)

    def spec(name, arg="1", **kw):
        d = dict(name=name, cmd=[sys.executable, str(script), arg], cpu_slots=1, resume_arg="--resume", cwd=str(tmp_path))
        d.update(kw)
        return JobSpec(**d)

    s = sup()
    yield type("E", (), dict(runs=runs, tmp=tmp_path, sup=staticmethod(sup), spec=staticmethod(spec), s=s))
    for st in runs.glob("*/state.json"):
        try:
            pid = json.loads(st.read_text()).get("pid")
            if pid:
                os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, ValueError, OSError):
            pass


def run_until(sup, cond, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        sup.tick()
        if cond():
            return
        time.sleep(0.05)
    raise AssertionError("timed out; status=" + json.dumps(read_status(sup.runs), indent=1))


def state(env, name):
    return read_state(env.runs, name)["state"]


def test_budget_json_says_three_slots_one_mps_nice_ten():
    b = load_budget(TRAINING / "budget.json")
    assert (b.cpu_slots, b.mps_jobs, b.nice) == (3, 1, 10)


def test_job_runs_to_done_with_log_and_status(env):
    enqueue(env.runs, env.spec("a", "0.3"))
    assert state(env, "a") == "QUEUED"
    run_until(env.s, lambda: state(env, "a") == "DONE")
    st = read_state(env.runs, "a")
    assert st["restarts"] == 0 and st["lastExit"] == 0
    assert (env.runs / "a" / "attempts.log").read_text().startswith("0.3|")
    status = read_status(env.runs)
    assert status["budget"] == {"cpuSlots": 5, "mpsJobs": 1, "nice": 10}
    assert status["jobs"]["a"]["state"] == "DONE"
    assert status["slotsUsed"] == 0


def test_status_json_while_running(env):
    enqueue(env.runs, env.spec("a", "5", cpu_slots=2))
    run_until(env.s, lambda: state(env, "a") == "RUNNING")
    status = read_status(env.runs)
    assert status["supervisorPid"] == os.getpid()
    assert status["slotsUsed"] == 2 and status["mpsUsed"] == 0
    j = status["jobs"]["a"]
    assert j["state"] == "RUNNING" and j["pid"] and j["cpuSlots"] == 2 and j["restarts"] == 0


def test_sigkilled_job_restarts_with_resume_and_completes(env):
    enqueue(env.runs, env.spec("a", "20"))
    run_until(env.s, lambda: state(env, "a") == "RUNNING")
    time.sleep(0.5)
    os.killpg(read_state(env.runs, "a")["pid"], signal.SIGKILL)
    run_until(env.s, lambda: state(env, "a") == "DONE")
    st = read_state(env.runs, "a")
    assert st["restarts"] == 1
    lines = (env.runs / "a" / "attempts.log").read_text().splitlines()
    assert [l.split("|")[0] for l in lines] == ["20", "20 --resume"]


def test_restarts_are_capped_at_three_then_failed(env):
    enqueue(env.runs, env.spec("bad", "fail"))
    run_until(env.s, lambda: state(env, "bad") == "FAILED")
    st = read_state(env.runs, "bad")
    assert st["restarts"] == 3 and "exit" in st["reason"]
    assert len((env.runs / "bad" / "attempts.log").read_text().splitlines()) == 4


def test_job_asking_for_more_slots_than_free_waits(env):
    enqueue(env.runs, env.spec("big", "1.5", cpu_slots=4))
    enqueue(env.runs, env.spec("other", "0.3", cpu_slots=3))
    run_until(env.s, lambda: state(env, "big") == "RUNNING")
    for _ in range(10):
        env.s.tick()
        assert state(env, "other") == "QUEUED"
        time.sleep(0.05)
    assert read_status(env.runs)["slotsUsed"] == 4
    run_until(env.s, lambda: state(env, "other") == "DONE")
    assert state(env, "big") == "DONE"


def test_small_job_backfills_while_a_big_one_waits(env):
    enqueue(env.runs, env.spec("first", "2", cpu_slots=3))
    enqueue(env.runs, env.spec("big", "0.3", cpu_slots=3))
    enqueue(env.runs, env.spec("small", "0.3", cpu_slots=2))
    run_until(env.s, lambda: state(env, "small") in ("RUNNING", "DONE"))
    assert state(env, "big") == "QUEUED"


def test_job_needing_more_than_the_budget_fails_at_once(env):
    enqueue(env.runs, env.spec("huge", "1", cpu_slots=6))
    run_until(env.s, lambda: state(env, "huge") == "FAILED")
    assert "6" in read_state(env.runs, "huge")["reason"]


def test_only_one_mps_job_at_a_time(env):
    enqueue(env.runs, env.spec("m1", "1.5", cpu_slots=0, mps=True))
    enqueue(env.runs, env.spec("m2", "0.3", cpu_slots=0, mps=True))
    run_until(env.s, lambda: state(env, "m1") == "RUNNING")
    for _ in range(8):
        env.s.tick()
        assert state(env, "m2") == "QUEUED"
        time.sleep(0.05)
    assert read_status(env.runs)["mpsUsed"] == 1
    run_until(env.s, lambda: state(env, "m2") == "DONE")


def test_after_is_respected(env):
    enqueue(env.runs, env.spec("child", "0.3", after=["parent"]))
    enqueue(env.runs, env.spec("parent", "1"))
    run_until(env.s, lambda: state(env, "parent") == "RUNNING")
    for _ in range(6):
        env.s.tick()
        assert state(env, "child") == "QUEUED"
        time.sleep(0.05)
    run_until(env.s, lambda: state(env, "child") == "DONE")
    assert read_state(env.runs, "parent")["state"] == "DONE"


def test_child_fails_when_its_parent_failed(env):
    enqueue(env.runs, env.spec("parent", "fail"))
    enqueue(env.runs, env.spec("child", "0.3", after=["parent"]))
    run_until(env.s, lambda: state(env, "child") == "FAILED")
    assert "parent" in read_state(env.runs, "child")["reason"]


def test_job_runs_with_the_enqueuing_worktree_as_cwd(env):
    wt = env.tmp / "worktree"
    wt.mkdir()
    enqueue(env.runs, env.spec("a", "0.3", cwd=str(wt)))
    run_until(env.s, lambda: state(env, "a") == "DONE")
    line = (env.runs / "a" / "attempts.log").read_text().strip()
    assert Path(line.split("|")[1]).resolve() == wt.resolve()


def test_stale_heartbeat_kills_and_restarts(env):
    s = env.sup(stale_s=1.5)
    enqueue(env.runs, env.spec("hung", "hang"))
    run_until(s, lambda: state(env, "hung") == "DONE", timeout=30)
    st = read_state(env.runs, "hung")
    assert st["restarts"] == 1


def test_max_hours_stops_the_job(env):
    enqueue(env.runs, env.spec("long", "60", max_hours=0.0005))
    run_until(env.s, lambda: state(env, "long") == "RUNNING")
    pid = read_state(env.runs, "long")["pid"]
    run_until(env.s, lambda: state(env, "long") == "TIMEOUT", timeout=30)
    with pytest.raises(ProcessLookupError):
        os.killpg(pid, 0)


def test_stop_request_stops_a_running_job_and_a_queued_one(env):
    enqueue(env.runs, env.spec("run", "60"))
    enqueue(env.runs, env.spec("wait", "1", cpu_slots=5))
    run_until(env.s, lambda: state(env, "run") == "RUNNING")
    request_stop(env.runs, "run")
    request_stop(env.runs, "wait")
    run_until(env.s, lambda: state(env, "run") == "STOPPED" and state(env, "wait") == "STOPPED")
    assert read_state(env.runs, "run")["restarts"] == 0


def test_a_new_supervisor_adopts_a_running_job(env):
    enqueue(env.runs, env.spec("a", "1.5"))
    run_until(env.s, lambda: state(env, "a") == "RUNNING")
    second = env.sup()  # the first supervisor "died": a fresh one reads the same runs dir
    run_until(second, lambda: state(env, "a") == "DONE")
    assert read_state(env.runs, "a")["restarts"] == 0


def test_enqueue_refuses_a_live_job_but_allows_rerun_of_a_finished_one(env):
    enqueue(env.runs, env.spec("a", "0.3"))
    with pytest.raises(ValueError):
        enqueue(env.runs, env.spec("a", "0.3"))
    run_until(env.s, lambda: state(env, "a") == "DONE")
    enqueue(env.runs, env.spec("a", "0.3"))
    assert state(env, "a") == "QUEUED"
    run_until(env.s, lambda: state(env, "a") == "DONE")
    assert len((env.runs / "a" / "attempts.log").read_text().splitlines()) == 2


def git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


def cli(*args, cwd, timeout=60):
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONPATH"] = str(TRAINING)
    return subprocess.run([sys.executable, "-m", "trainer.cli", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)


def test_second_worktree_attaches_to_the_same_supervisor_and_runs_dir(tmp_path):
    main = tmp_path / "main"
    main.mkdir()
    git("init", "-b", "main", cwd=main)
    (main / "f").write_text("x")
    git("add", "f", cwd=main)
    git("commit", "-m", "init", cwd=main)
    wt = tmp_path / "lane"
    git("worktree", "add", "-b", "lane", str(wt), cwd=main)
    budget = tmp_path / "budget.json"
    budget.write_text(json.dumps({"cpuSlots": 5, "mpsJobs": 1, "nice": 10}))
    script = tmp_path / "dummy.py"
    script.write_text(DUMMY)
    spec_file = tmp_path / "lanejob.json"
    spec_file.write_text(json.dumps({"name": "lanejob", "cmd": [sys.executable, str(script), "0.5"], "cpuSlots": 1, "mps": False,
                                     "maxHours": 1, "after": [], "resumeArg": "--resume", "checkpointDir": "runs/lanejob/ckpt", "milestones": {}}))
    try:
        up1 = cli("up", "--poll", "0.2", "--budget", str(budget), cwd=main)
        assert up1.returncode == 0, up1.stderr
        runs = main / "runs"
        pid1 = int((runs / "supervisor.pid").read_text())
        up2 = cli("up", "--poll", "0.2", "--budget", str(budget), cwd=wt)  # from the other worktree: attaches
        assert up2.returncode == 0, up2.stderr
        assert "already running" in up2.stdout
        assert int((runs / "supervisor.pid").read_text()) == pid1
        assert not (wt / "runs").exists()
        en = cli("enqueue", str(spec_file), cwd=wt)
        assert en.returncode == 0, en.stderr
        spec = json.loads((runs / "lanejob" / "spec.json").read_text())
        assert Path(spec["cwd"]).resolve() == wt.resolve()
        end = time.time() + 30
        while time.time() < end and read_state(runs, "lanejob")["state"] != "DONE":
            time.sleep(0.2)
        assert read_state(runs, "lanejob")["state"] == "DONE"
        assert Path((runs / "lanejob" / "attempts.log").read_text().strip().split("|")[1]).resolve() == wt.resolve()
        status = cli("status", cwd=wt)
        assert status.returncode == 0 and "supervisor: up" in status.stdout and "lanejob" in status.stdout and "DONE" in status.stdout
    finally:
        cli("down", cwd=main)
    end = time.time() + 10
    while time.time() < end:
        try:
            os.kill(pid1, 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        os.kill(pid1, signal.SIGKILL)
        pytest.fail("supervisor did not exit on down")


# ---- fix round 1 ------------------------------------------------------------
def test_adopting_supervisor_never_kills_a_foreign_process_with_a_recycled_pid(env):
    enqueue(env.runs, env.spec("four-az", "1"))
    foreign = subprocess.Popen(["sleep", "300"], start_new_session=True)
    try:
        st = read_state(env.runs, "four-az")
        old = time.time() - 3600
        st.update(state="RUNNING", pid=foreign.pid, firstStartedAt=old, attemptStartedAt=old)
        from trainer.jobs import write_json
        write_json(env.runs / "four-az" / "state.json", st)
        env.sup().tick()
        time.sleep(0.5)
        assert foreign.poll() is None, "the supervisor killed a process it did not start"
        new = read_state(env.runs, "four-az")
        assert new["pid"] != foreign.pid and new["restarts"] == 1  # treated as dead, relaunched
    finally:
        foreign.kill()
        foreign.wait()


def test_stop_and_max_hours_do_not_kill_a_foreign_pid(env):
    from trainer.jobs import write_json
    foreign = subprocess.Popen(["sleep", "300"], start_new_session=True)
    try:
        enqueue(env.runs, env.spec("a", "1", max_hours=0.0001))
        st = read_state(env.runs, "a")
        st.update(state="RUNNING", pid=foreign.pid, firstStartedAt=time.time() - 3600, attemptStartedAt=time.time())
        write_json(env.runs / "a" / "state.json", st)
        request_stop(env.runs, "a")
        env.sup().tick()
        time.sleep(0.3)
        assert foreign.poll() is None
        assert state(env, "a") == "STOPPED"
    finally:
        foreign.kill()
        foreign.wait()


def test_adopted_real_job_is_still_recognised_and_killed_on_stop(env):
    enqueue(env.runs, env.spec("a", "60"))
    run_until(env.s, lambda: state(env, "a") == "RUNNING")
    pid = read_state(env.runs, "a")["pid"]
    second = env.sup()
    request_stop(env.runs, "a")
    run_until(second, lambda: state(env, "a") == "STOPPED")
    env.s.procs["a"].wait(timeout=5)  # the first supervisor reaps its own child, so the group can vanish
    with pytest.raises(ProcessLookupError):
        os.killpg(pid, 0)


def test_spec_rejects_bad_max_hours_after_and_mps():
    base = {"name": "j", "cmd": ["true"]}
    for bad in ({"maxHours": "4"}, {"maxHours": 0}, {"maxHours": -1}, {"maxHours": True},
                {"after": "chess-data"}, {"after": [1]}, {"mps": "yes"}, {"mps": 1}):
        with pytest.raises(ValueError):
            JobSpec.from_json({**base, **bad})
    ok = JobSpec.from_json({**base, "maxHours": 4, "after": ["x"], "mps": True})
    assert (ok.max_hours, ok.after, ok.mps) == (4, ["x"], True)
    assert JobSpec.from_json({**base, "maxHours": None}).max_hours is None


def test_enqueue_via_cli_path_refuses_a_bad_spec(tmp_path):
    from trainer.jobs import load_spec
    f = tmp_path / "bad.json"
    f.write_text(json.dumps({"name": "bad", "cmd": ["true"], "maxHours": "4"}))
    with pytest.raises(ValueError):
        load_spec(str(f))


def test_one_broken_job_does_not_stall_the_others(env, capsys):
    from trainer.jobs import write_json
    enqueue(env.runs, env.spec("bad", "1"))
    enqueue(env.runs, env.spec("good", "0.3"))
    # a spec written behind enqueue's back with a string maxHours, sorting before "good"
    sp = json.loads((env.runs / "bad" / "spec.json").read_text())
    sp["maxHours"] = "4"
    write_json(env.runs / "bad" / "spec.json", sp)
    st = read_state(env.runs, "bad")
    st.update(state="RUNNING", pid=None, firstStartedAt=time.time(), attemptStartedAt=time.time())
    write_json(env.runs / "bad" / "state.json", st)
    # make the damage reach _check_running: bypass validation by injecting a spec object directly
    real_load = env.s._load

    def load(name):
        v = real_load(name)
        if name == "bad":
            spec = env.spec("bad", "1")
            spec.max_hours = "4"
            return spec, read_state(env.runs, "bad")
        return v

    env.s._load = load
    env.s._alive = lambda name, st: name == "bad" or Supervisor._alive(env.s, name, st)
    run_until(env.s, lambda: state(env, "good") == "DONE")
    assert (env.runs / "status.json").exists()
    assert "job bad failed this tick" in capsys.readouterr().err


def test_job_runs_at_budget_nice_even_when_the_supervisor_is_already_niced(tmp_path):
    out = tmp_path / "nice.txt"
    prog = textwrap.dedent(f"""
        import os, subprocess, sys, time
        from pathlib import Path
        os.nice(10)
        from trainer.budget import Budget
        from trainer.jobs import JobSpec, enqueue
        from trainer.supervisor import Supervisor
        runs = Path({str(tmp_path / 'runs')!r}); runs.mkdir()
        cmd = [sys.executable, "-c", "import os; open({str(out)!r}, 'w').write(str(os.getpriority(os.PRIO_PROCESS, 0)))"]
        enqueue(runs, JobSpec(name="n", cmd=cmd, cwd={str(tmp_path)!r}))
        s = Supervisor(runs, Budget(5, 1, 10), poll=0.05)
        end = time.time() + 20
        while time.time() < end and not Path({str(out)!r}).exists():
            s.tick(); time.sleep(0.1)
    """)
    envv = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    envv["PYTHONPATH"] = str(TRAINING)
    r = subprocess.run([sys.executable, "-c", prog], env=envv, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    assert out.read_text() == "10"
