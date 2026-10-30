import json
import subprocess
import sys
import tempfile
from pathlib import Path

SUITE = Path(__file__).resolve().parents[1] / "run_suite.py"


def make_tree(root: Path, ts_fail: bool):
    (root / "a").mkdir()
    (root / "a" / "ok.test.ts").write_text(
        "import {test,expect} from 'bun:test'\ntest('ok',()=>{expect(1).toBe(1)})\n"
    )
    (root / "a" / "flaky.test.ts").write_text(
        "import {test,expect} from 'bun:test'\ntest('x',()=>{expect(1).toBe(%d)})\n" % (2 if ts_fail else 1)
    )
    (root / "scripts" / "tests").mkdir(parents=True)
    (root / "scripts" / "tests" / "test_p.py").write_text("def test_p():\n    assert True\n")


def run(root: Path, label: str, *extra: str):
    return subprocess.run(
        [sys.executable, str(SUITE), "--root", str(root), "--label", label, "--skip-extras", *extra],
        capture_output=True,
        text=True,
    )


def test_writes_json_and_compare_reports_one_regression():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        make_tree(root, ts_fail=False)
        r = run(root, "base")
        assert r.returncode == 0, r.stdout + r.stderr
        base = json.loads((root / "plan" / "suite" / "base.json").read_text())
        assert base["files"]["a/ok.test.ts"] == "PASS"
        assert base["files"]["a/flaky.test.ts"] == "PASS"
        assert base["files"]["scripts/tests/test_p.py"] == "PASS"

        make_tree_fail = root / "a" / "flaky.test.ts"
        make_tree_fail.write_text("import {test,expect} from 'bun:test'\ntest('x',()=>{expect(1).toBe(2)})\n")
        r2 = run(root, "next", "--compare", str(root / "plan" / "suite" / "base.json"))
        assert r2.returncode == 0, r2.stdout + r2.stderr
        assert "VERDICT: REGRESSIONS 1" in r2.stdout
        cur = json.loads((root / "plan" / "suite" / "next.json").read_text())
        assert cur["files"]["a/flaky.test.ts"] == "FAIL"
        assert r2.stdout.count("REGRESSION: ") == 1
        assert "REGRESSION: a/flaky.test.ts" in r2.stdout


def test_slow_only_pytest_file_is_skipped_not_failed():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "training" / "tests").mkdir(parents=True)
        (root / "training" / "pyproject.toml").write_text(
            "[tool.pytest.ini_options]\naddopts = \"-m 'not slow'\"\nmarkers = [\"slow: slow\"]\n"
        )
        (root / "training" / "tests" / "test_slow.py").write_text(
            "import pytest\n\n@pytest.mark.slow\ndef test_s():\n    assert True\n"
        )
        r = run(root, "base")
        assert r.returncode == 0, r.stdout + r.stderr
        assert "SKIP training/tests/test_slow.py" in r.stdout
        base = json.loads((root / "plan" / "suite" / "base.json").read_text())
        assert "training/tests/test_slow.py" not in base["files"]
        r2 = run(root, "next", "--compare", str(root / "plan" / "suite" / "base.json"))
        assert "NEW FILE NOT PASSING" not in r2.stdout
        assert "VERDICT: REGRESSIONS 0, NEW FILES NOT PASSING 0" in r2.stdout
