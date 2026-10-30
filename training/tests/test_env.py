import os
import sys
from pathlib import Path


def test_trainer_importable_from_this_worktree():
    import trainer

    assert Path(trainer.__file__).resolve().parents[1] == Path(__file__).resolve().parents[1]


def test_python_version():
    assert sys.version_info[:2] == (3, 12)


def test_pythonpath_points_at_training():
    assert str(Path(__file__).resolve().parents[1]) in os.environ.get("PYTHONPATH", "").split(os.pathsep)
