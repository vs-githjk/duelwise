#!/usr/bin/env python3
"""Whole-suite regression runner.

Runs every *.test.ts alone with `bun test`, every training/tests/test_*.py and
scripts/tests/test_*.py alone with `scripts/py -m pytest -q`, then `bun run typecheck`,
the web production build and every Playwright spec. Writes per-file PASS/FAIL to
plan/suite/<label>.json. With --compare, prints REGRESSIONS and NEW FILES NOT PASSING.
The exit code is 0 unless the runner itself is misused; the verdict is in the output.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

TIMEOUT_S = 300
SKIP_DIRS = {".claude", "node_modules", ".venv", ".git", "runs", "data", ".data", ".output", "__pycache__", "dist"}


def walk(root: Path):
    for p in sorted(root.rglob("*")):
        if any(part in SKIP_DIRS for part in p.relative_to(root).parts):
            continue
        if p.is_file():
            yield p


def discover(root: Path):
    bun, py, e2e = [], [], []
    for p in walk(root):
        rel = p.relative_to(root).as_posix()
        name = p.name
        if name.endswith(".test.ts") and not name.endswith(".slow.test.ts"):
            bun.append(rel)
        elif name.startswith("test_") and name.endswith(".py") and (
            rel.startswith("training/tests/") or rel.startswith("scripts/tests/")
        ):
            py.append(rel)
        elif name.endswith(".spec.ts") and rel.startswith("apps/web/e2e/"):
            e2e.append(rel)
    return bun, py, e2e


def run(cmd, root: Path):
    try:
        r = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return "FAIL", f"timeout after {TIMEOUT_S}s"
    out = (r.stdout + r.stderr).strip().splitlines()
    last = out[-1] if out else ""
    if cmd[1:3] == ["-m", "pytest"] and r.returncode == 5:
        # pytest exit 5: nothing collected, e.g. a file whose tests are all marked slow
        return "SKIP", last
    return ("PASS" if r.returncode == 0 else "FAIL"), last


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--compare")
    ap.add_argument("--shard", default="1/1")
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    ap.add_argument("--skip-extras", action="store_true", help="only per-file bun and pytest runs (used by this runner's own test)")
    a = ap.parse_args()
    root = Path(a.root).resolve()
    i, n = (int(x) for x in a.shard.split("/"))
    if not (1 <= i <= n):
        print("bad --shard", file=sys.stderr)
        return 2
    py_bin = root / "scripts" / "py"
    if not py_bin.exists():
        py_bin = Path(__file__).resolve().parent / "py"

    bun, py, e2e = discover(root)
    jobs = [(f, ["bun", "test", str(root / f)]) for f in bun]
    jobs += [(f, [str(py_bin), "-m", "pytest", "-q", str(root / f)]) for f in py]
    if not a.skip_extras:
        jobs += [(f, ["bun", "run", "e2e", "--", f.removeprefix("apps/web/")]) for f in e2e]
    jobs.sort(key=lambda j: j[0])
    mine = [j for k, j in enumerate(jobs) if k % n == i - 1]

    files = {}
    for rel, cmd in mine:
        status, last = run(cmd, root)
        if status != "SKIP":
            files[rel] = status
        print(f"{status} {rel}  {last}", flush=True)

    if not a.skip_extras and i == 1:
        status, last = run(["bun", "run", "typecheck"], root)
        files["typecheck"] = status
        print(f"{status} typecheck  {last}", flush=True)
        if (root / "apps" / "web" / "vite.config.ts").exists():
            status, last = run(["bun", "run", "--cwd", str(root / "apps" / "web"), "build"], root)
        else:
            status, last = "SKIP", "apps/web has no vite.config.ts yet"
        files["web-build"] = status
        print(f"{status} web-build  {last}", flush=True)

    out = root / "plan" / "suite"
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{a.label}.json").write_text(json.dumps({"label": a.label, "shard": a.shard, "files": files}, indent=2, sort_keys=True) + "\n")
    passed = sum(1 for s in files.values() if s == "PASS")
    print(f"SUMMARY: {passed}/{len(files)} PASS")

    if a.compare:
        base = json.loads(Path(a.compare).read_text())["files"]
        regressions = [f for f, s in base.items() if s == "PASS" and f in files and files[f] == "FAIL"]
        regressions += [f for f, s in base.items() if s == "PASS" and f not in files and a.shard == "1/1"]
        new_bad = [f for f, s in files.items() if f not in base and s == "FAIL"]
        for f in regressions:
            print(f"REGRESSION: {f}")
        for f in new_bad:
            print(f"NEW FILE NOT PASSING: {f}")
        print(f"VERDICT: REGRESSIONS {len(regressions)}, NEW FILES NOT PASSING {len(new_bad)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
