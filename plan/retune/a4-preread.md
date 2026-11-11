# A4 pre-read: Tinderbox and Coldstore against people's hands

Measured Tue Nov 10 2026 13:23 to 13:33 EST on branch game/retune-a4, 120 to 128 matches per seat per profile. Raw rows: `plan/retune/a4/<game>-<level>.json`.

The flaw fixed first: the gate bots for both games played under the same limits as the level they test (`packages/agents/src/measure/fighter.ts:363`), and the Champion gate bots saw the live game. A person gets neither. The test players now play with a person's hands (`packages/core/src/people-hands.ts`): beginner 18 frames (300 ms) late, 160 presses a minute, hold 6 frames, 10% slips; average 15 frames, 240 presses, hold 4, 5% slips; strong 12 frames, no cap, hold 1, 2% slips; Coldstore adds a turn rate (220, 400, 540 degrees a second) and aim noise (4, 1.5, 0 degrees). The delay is the same at Champion. These numbers are builder choices, not measured people; the estimate labels them.

Test players: four person-like styles for Tinderbox (rushdown, turtle, zoner, fireball) and five for Coldstore (rusher, holder, peeker, strafe, holdangle), equal matches each. The exploit loops (throwloop, backwalk and the rest) stay gate bots; a person does not play them. Weights 30 / 50 / 20 (D2). The net under test is the published snapshot, at its level's own limits (Tinderbox Easy, Medium and Hard are one network).

| level | old gate styles (level limits) | beginner | average | strong | people estimate 30/50/20 | band | verdict |
|---|---|---|---|---|---|---|---|
| Tinderbox Easy | 62.5% | 87.5% | 72.7% | 58.6% | 74.3% (71.1 to 77.5) | 42 to 58 | above |
| Tinderbox Medium | 94.9% | 100.0% | 99.2% | 99.2% | 99.5% (98.7 to 100) | 65 to 75 | above |
| Tinderbox Hard | 98.8% | 100.0% | 100.0% | 99.2% | 99.8% (99.3 to 100) | 80 to 90 | above |
| Tinderbox Champion | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% (99.5 to 100) | 93 to 100 | in band |
| Coldstore Easy | 89.2% | 95.0% | 90.8% | 67.3% | 87.4% (85.0 to 89.7) | 42 to 58 | above |
| Coldstore Medium | 95.8% | 100.0% | 97.9% | 84.4% | 95.8% (94.5 to 97.2) | 65 to 75 | above |
| Coldstore Hard | 81.5% | 100.0% | 98.8% | 90.8% | 97.5% (96.4 to 98.7) | 80 to 90 | above |
| Coldstore Champion | 98.5% | 100.0% | 100.0% | 100.0% | 100.0% (99.5 to 100) | 93 to 100 | in band |

Real matches (human-baseline.csv) are all under the minimum of 40 matches and 10 players, so the panel stands alone; as a hint they point the same way: Tinderbox Easy 10 of 15 (67%), Medium 24 of 26 (92%), Hard 23 of 24 (96%, 2 players); Coldstore Easy 6 of 8, Medium 1 of 3, Hard 1.5 of 3.

Finding: no level is under its band, so there is nothing to retrain. Six of eight are above it (too strong for people, not too weak) and the two Champions sit in band. Training a stronger Hard against these bots would move it the wrong way. The fix for the levels above their band is weakening by published limits and settings (A8), the same for every player; Tinderbox Easy, Medium and Hard share one network, which A8 already treats this way. No job was queued.

Reproduce (niced, one process, about 1 to 3 minutes a level; run under `plan/heavy-lock.sh`):
`bun packages/agents/src/measure/fighter-people.ts --ckpt <snap.pt> --level hard --games 50 --out <json>` and the same with `arena-people.ts --games 40`. The matches run in the trainer's own env (`trainer.ppo.eval_bots` with `kind@profile` bots), so a number here is the number the trainer sees. Checkpoints: Tinderbox Easy to Hard `runs/fighter-league-b5/gated/hard/snap-hard-0030015488.pt`, Champion `runs/fighter-league-b6/gated/champion/snap-champion-0196034560.pt`; Coldstore Easy and Medium `runs/arena-league-b4/gated/easy/snap-easy-0008028160.pt`, Hard `runs/arena-league-b5/gated/hard/snap-hard-0036003840.pt`, Champion `runs/arena-league-b4/gated/champion/snap-champion-0012025856.pt` (all under /Users/vidyutsriram/projects/beatme/runs).

Training support is in and smoke-tested for when it is wanted (`--people-bots average,strong` on `train_realtime --stage B` for fighter and arena: the pool shows `rushdown@average` and the rest, 150k fighter and 40k arena steps ran clean). Not run for real.
