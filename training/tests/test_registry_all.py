"""Every registry file under packages/agents/registry passes the Python validator, so a publish (write_registry) never refuses a game."""

from pathlib import Path

import pytest

from trainer.paths import worktree_root
from trainer.registry import GAMES, load_registry, validate_registry

REGISTRY_DIR = worktree_root(Path(__file__).resolve().parent) / "packages" / "agents" / "registry"
FILES = sorted(p for p in REGISTRY_DIR.glob("*.json") if p.name != "adapters.json")


def test_registry_files_found():
    assert len(FILES) >= 10


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_registry_validates(path):
    assert validate_registry(load_registry(path)) == []


def test_puck_is_a_game():
    assert "puck" in GAMES
