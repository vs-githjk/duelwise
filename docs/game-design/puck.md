# Puck (Glasscut): air hockey sim and rules

Headless sim in `packages/core/src/games/puck/` (task P1). Internal id `puck`; the shown name is set at promotion. 60 Hz fixed tick,
4 substeps of 1/240 s, deterministic from (seed, inputs). One implementation serves the browser, the server replay, the
measurement harness and the trainer (the Python side never simulates). Core version `puck-1`.

Every number is an ESTIMATE (chosen by us from air hockey feel, not read from a source) unless marked REPORTED. Nothing here is
REPORTED yet: no outside page was fetched. All numbers are tuned only in P1 and P4, and the determinism vectors are regenerated when one moves.

## Units and views

- Table width W = 1, length 2. World x in [0, 1], world y in [0, 2]. Seat 0 (the human, always) defends y = 0, seat 1 defends y = 2.
- A seat's view is its own: seat 1 sees the table rotated 180 degrees (x' = 1 - x, y' = 2 - y, velocities negated), so every seat defends y = 0.
- The sim never knows the screen orientation; portrait and landscape are drawing choices.

## Numbers

| Item | Value | Status |
|---|---|---|
| Tick | 1/60 s, 4 substeps of 1/240 s | ESTIMATE |
| Puck radius | 0.04 | ESTIMATE |
| Mallet radius | 0.065 | ESTIMATE |
| Goal mouth | 0.34 wide, centred (x from 0.33 to 0.67); the posts are point obstacles of the puck radius | ESTIMATE |
| Puck top speed | 4.5 W/s, clamped after every hit | ESTIMATE |
| Puck drag | about 0.985 per second, applied per substep as a fixed factor 0.999937 (no pow in the sim); wall restitution 0.9 | ESTIMATE |
| Mallet rule speed cap | 6 W/s for every seat; per-seat limits can only be lower | ESTIMATE |
| Mallet acceleration | default 120 W/s^2 (human and rule), lower for agent levels | ESTIMATE |
| Mallet zone | centre inside its own half with the whole mallet on its side of the centre line: y in [r, 1 - r] for seat 0, [1 + r, 2 - r] for seat 1; x in [r, 1 - r] | ESTIMATE |
| Mallet to puck | moving-body hit, restitution 0.85, mallet velocity transferred, then the top-speed clamp | ESTIMATE |
| Serve | after a goal the scored-on seat gets the puck at rest at (0.5, 0.5) of its half; 45 frames of freeze. First serve from the seeded rng | ESTIMATE |
| Possession rule | puck in one half for 420 frames (7 s) is a foul by the seat whose half it is; the other seat serves. The count only changes hands when the puck centre is more than one puck radius (0.04) past the line, so a puck rattling on the line cannot restart it | ESTIMATE |
| Dead puck | |y - 1| < 0.3 for 180 frames while slow (under 0.05 W/s) or within 0.04 of where the count began (a jittering jam is dead too): serve to the seat that did not touch it last | ESTIMATE |
| Match | first to 7 goals; at 21,600 frames (6 min) the leader wins and a level score goes to sudden death (next goal wins); hard cap 36,000 frames ends a draw | ESTIMATE |

## Collision method

Per substep, in a fixed order: mallets move (speed and acceleration capped, clamped to their zone), then the puck is swept as a circle
against, in order: the side walls, the two end walls (with the goal gap), the four posts, mallet 0, mallet 1. The earliest hit inside the
remaining substep time wins, ties go to the earlier item in that order. The puck reflects inside the substep (it is never clamped to a
rail), then continues for the rest of the substep, up to 6 hits. Mallet hits are solved in the mallet's frame (relative motion, quadratic
time of impact, only `sqrt`). A puck pinned between a mallet and a wall is slid along the wall tangent; if no such place exists the mallet
stops at contact (backs off). No overlap is allowed after any substep.

## Goal

The puck centre crosses a goal line inside the mouth. The posts have the puck radius, so the puck centre needs 0.04 of room from each post:
the centre mouth is 0.26 wide.

## Events (per seat counters plus `lastEvent {frame, kind, seat}`)

- goal: the puck crossed the opponent's goal line. Own goals count for the opponent.
- shot: a mallet hit sends the puck on a straight line (walls ignored) across the opponent's goal mouth.
- save: the defender's mallet touches the puck while a shot on target by the other seat is live. A shot is on target when its straight line crosses the far goal line where the puck centre can score: inside the 0.34 mouth less one puck radius at each post, so x in 0.37 to 0.63.
- post: the puck hits a post at the end the seat attacks, last touched by that seat.
- nearMiss: the puck hits the end wall within 0.08 of a post, outside the mouth, at normal speed 1 W/s or more, last touched by the attacker.
- foul: the possession rule fired against this seat.

## Input

One integer per seat per frame: the target point on a 1024 x 1024 grid over the seat's own half in its own view, `code = x + 1024 * y`.
`NO_INPUT` (1024 * 1024) means keep the held target. Anything out of range or not an integer is treated as `NO_INPUT`, so a forged record cannot crash a replay.
The mallet moves toward the target under its speed and acceleration caps.

## Match end

`result.reason` is `goals`, `time`, `sudden` or `draw`.
