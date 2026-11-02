"""The agent registry, from Python: read, validate, add a version, promote, write.

The file format and the checks are those of packages/agents/src/registry.ts (a test round-trips the real four.json
byte for byte). The TS side writes measured ladders; this side writes version history after a retrain."""

from __future__ import annotations

import copy
import json
import os
import tempfile
from pathlib import Path

LEVELS = ("easy", "medium", "hard", "champion")
STATUSES = ("preview", "measured", "candidate", "retired")
GAMES = ("chess", "four", "holdem", "word", "fighter", "arena", "fleet")


class RegistryError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("Invalid registry: " + "; ".join(errors))
        self.errors = errors


def load_registry(path: Path | str) -> dict:
    return json.loads(Path(path).read_text())


def validate_registry(reg: dict) -> list[str]:
    """Returns the list of problems (empty when valid): shape, version links, and a measured block for every published level."""
    errors: list[str] = []
    if reg.get("game") not in GAMES:
        errors.append(f"game: {reg.get('game')!r} is not a game")
    versions = reg.get("versions")
    if not isinstance(versions, list) or not versions:
        return errors + ["versions: needs at least one version"]
    names = [v.get("version") for v in versions]
    if len(set(names)) != len(names):
        errors.append("versions: duplicate version names")
    by_name = {v.get("version"): v for v in versions}
    if reg.get("champion") not in by_name:
        errors.append(f"champion: {reg.get('champion')} is not in versions")
    for v in versions:
        n = v.get("version")
        if v.get("status") not in STATUSES:
            errors.append(f"versions.{n}.status: {v.get('status')!r}")
        if v.get("parent") is not None and v["parent"] not in by_name:
            errors.append(f"versions.{n}.parent: {v['parent']} is not in versions")
        for k in v.get("sha256", {}):
            if k not in v.get("artifacts", {}):
                errors.append(f"versions.{n}.sha256.{k}: no artifact with that name")
        for key in ("trainedSteps", "humanMatchesUsed"):
            if not isinstance(v.get(key), int) or v[key] < 0:
                errors.append(f"versions.{n}.{key}: must be a non-negative integer")
    levels, measured = reg.get("levels", {}), reg.get("measured", {})
    for level in LEVELS:
        entry, block = levels.get(level), measured.get(level)
        if not entry:
            if block:
                errors.append(f"measured.{level}: level {level} is not in levels")
            continue
        version = by_name.get(entry.get("version"))
        if not version:
            errors.append(f"levels.{level}.version: {entry.get('version')} is not in versions")
            continue
        if version["status"] != "preview" and not block:
            errors.append(f"levels.{level}: published level {level} has no measured block")
        if reg.get("unpublished", {}).get(level):
            errors.append(f"levels.{level}: {level} is both published and listed in unpublished")
    for level, m in measured.items():
        lo, hi = m["ci95"]
        if not lo <= m["value"] <= hi:
            errors.append(f"measured.{level}: ci95 [{lo}, {hi}] does not contain value {m['value']}")
    if not isinstance(reg.get("learnsFromHumans"), bool):
        errors.append("learnsFromHumans: must be a boolean")
    return errors


def write_registry(path: Path | str, reg: dict) -> None:
    """Validates, then writes atomically with the 2-space indent and trailing newline the TS writer uses."""
    errors = validate_registry(reg)
    if errors:
        raise RegistryError(errors)
    atomic_write_text(path, json.dumps(reg, indent=2, ensure_ascii=False) + "\n")


def atomic_write_text(path: Path | str, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def next_version(reg: dict) -> str:
    """v<N+1> for the highest numbered version so far (rejected candidates keep their numbers)."""
    nums = [int(v["version"][1:]) for v in reg["versions"] if v["version"][:1] == "v" and v["version"][1:].isdigit()]
    return f"v{max(nums, default=0) + 1}"


def add_version(reg: dict, *, version: str, parent: str, artifacts: dict, sha256: dict, trained_steps: int,
                human_matches_used: int, gate: dict | None, created_at: str, status: str = "candidate") -> dict:
    """Returns a new registry with the version appended as a candidate (never the champion)."""
    out = copy.deepcopy(reg)
    if any(v["version"] == version for v in out["versions"]):
        raise ValueError(f"version {version} already exists")
    out["versions"].append({
        "version": version, "parent": parent, "createdAt": created_at, "promotedAt": None, "status": status,
        "artifacts": artifacts, "sha256": sha256, "trainedSteps": trained_steps,
        "humanMatchesUsed": human_matches_used, "gate": gate,
    })
    return out


def promote(reg: dict, *, version: str, level_config: dict, measured_block: dict, promoted_at: str) -> dict:
    """Makes `version` the champion: its Champion level, its measured block, status measured. Easy, Medium and Hard stay with their versions."""
    out = copy.deepcopy(reg)
    v = next(x for x in out["versions"] if x["version"] == version)
    v["status"] = "measured"
    v["promotedAt"] = promoted_at
    out["champion"] = version
    out["levels"]["champion"] = {"version": version, "config": level_config}
    out["measured"]["champion"] = measured_block
    if out.get("unpublished", {}).get("champion"):
        del out["unpublished"]["champion"]
    return out


def champion_artifact(reg: dict, level: str = "champion") -> str:
    """The artifact path (repo relative) of the version serving `level`."""
    entry = reg["levels"][level]
    version = next(v for v in reg["versions"] if v["version"] == entry["version"])
    return version["artifacts"][level]
