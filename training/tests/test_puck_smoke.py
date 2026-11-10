"""Air hockey smoke (P4): 15 minutes of stage A on 2 slots, then the learner against every scripted bot.

Slow, excluded from the whole-suite run:  scripts/py -m pytest -m slow training/tests/test_puck_smoke.py -s
Set PUCK_SMOKE_OUT=/abs/path/smoke.json to keep the per-bot numbers; PUCK_SMOKE_SECONDS shortens the training (default 780).
"""

import json
import os
import time
from pathlib import Path

import pytest

from trainer.ppo import eval_bots as E
from trainer.ppo import league as L
from trainer.ppo import train_realtime as T


@pytest.mark.slow
def test_smoke_the_learner_beats_the_random_bot_in_200_games(tmp_path):
    seconds = float(os.environ.get("PUCK_SMOKE_SECONDS", "780"))
    tr = T.Trainer("puck", T.make_stage("A", None, None), T.RunPaths(tmp_path / "ckpt", tmp_path / "league", [], tmp_path),
                   procs=2, envs_per_proc=128, seed=11, snapshot_every=1_000_000, log=print)
    t0 = time.time()
    step = tr.run(10**9, max_seconds=seconds)
    train_s = time.time() - t0
    bots = {}
    for bot in L.BOTS["puck"]:
        r = E.evaluate(tr.agent, bot, 200, game="puck", level="champion", n_envs=16)
        bots[bot] = {"games": r["games"], "wins": r["wins"], "draws": r["draws"], "losses": r["losses"], "score": round(r["score"], 4),
                     "ci95": r["ci95"], "bySeat": {k: round(v["score"], 3) for k, v in r["bySeat"].items()}}
    out = {"trainSeconds": round(train_s), "steps": step, "bots": bots}
    print("SMOKE", json.dumps(out))
    if os.environ.get("PUCK_SMOKE_OUT"):
        Path(os.environ["PUCK_SMOKE_OUT"]).write_text(json.dumps(out, indent=2) + "\n")
    assert bots["random"]["games"] >= 200
    assert bots["random"]["score"] >= 0.80
