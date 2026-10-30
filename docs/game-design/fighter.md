# Fighter: frame data and rules

Headless sim in `packages/core/src/games/fighter/` (task T6). 60 Hz fixed step, integers only,
deterministic from (seed, inputs). The numbers are tuned from public frame data of a modern 2D
fighting game so the timing feels the same; every name, hitbox, character and the geometry are
original. This file may name the reference game as a source; product copy never does.

## How to read the sources

Each row says where a number comes from.

- REPORTED: recalled from the public community frame data and rounded to a clean value. Not read
  from a primary source in this task. The wiki pages below sit behind a bot check that blocked a
  direct fetch on 2026-10-21, so none of these values was re-read from the page. Treat each as a
  design target, and confirm against the page before quoting it anywhere outside the repo.
- TUNED: chosen by us for this sim (no public equivalent, or the public value depends on art
  and stage size). These are ours to change.

Source pages (all public):

- S1 Frame data for the all-rounder archetype the normals are modelled on: https://wiki.supercombo.gg/w/Street_Fighter_6/Ryu
- S2 Gauge, parry, rush, impact and burnout rules: https://wiki.supercombo.gg/w/Street_Fighter_6/Drive_System
- S3 Global rules (health, round timer, hitstop, throw tech window, damage scaling, super gauge): https://wiki.supercombo.gg/w/Street_Fighter_6/Game_Data
- S4 Control scheme (Modern controls: direction plus a small set of buttons): https://www.streetfighter.com/6/

## Conventions

- `startup` is the number of the first active frame (startup 4 means the move can connect on its
  4th frame). `active` is the count of active frames. `recovery` is the count of frames after the
  last active frame. Move length is `startup + active - 1 + recovery`.
- Advantage on hit or block is measured from a contact on the first active frame: the defender's
  stun minus the attacker's remaining frames. The sim stores the stun and derives it from the
  advantage: `stun = advantage + (active - 1) + recovery`. `fighter.test.ts` checks +4 on hit and
  +1 on block for the light attack against the running sim.
- Hitstop freezes both fighters (and the projectiles) for the same number of frames, so it does not
  change advantage.
- World units: a fighter is 60 wide (pushbox) and 170 tall; the stage runs from -800 to 800. Two fighters may never stand more than 850 units apart (MAX_SEPARATION, env fighter-env-3, R30): the camera shows about 935 units at its widest, and without the limit a fighter could walk out of the frame. The one who moves apart is stopped; a standing opponent is not dragged.
  Start positions are -250 and 250. All TUNED.

## Global rules

| Rule | Value | Source |
|---|---|---|
| Health | 10000 | S3, REPORTED |
| Round timer | 99 s (5940 frames) | S3, REPORTED |
| Rounds to win | 2 (best of 3); a drawn round counts for both; a 5th round ends the match | S3, REPORTED (draw handling TUNED) |
| Frame rate | 60 | S3, REPORTED |
| Intro before each round | 30 frames, no input | TUNED |
| Round end pause | 90 frames | TUNED |
| Input buffer | 4 frames (does not age during hitstop, so a cancel can be entered in hitstop) | S3, REPORTED |
| Walk forward / back | 4 / 3 units per frame | TUNED to S1 ratios |
| Forward dash | 17 frames, 9 units per frame | S1, REPORTED length; speed TUNED |
| Back dash | 22 frames, 7 units per frame for 16 frames, invulnerable to strikes, throws and projectiles on frames 1 to 6 | S1, REPORTED length and invulnerability; speed TUNED |
| Dash input | double tap within 12 frames of a release | TUNED |
| Jump | 4 prejump frames (throw invulnerable), 45 frames in the air (peak 253 units), forward or back 6 units per frame | S1, REPORTED length; geometry TUNED |
| Throw range | 70 units | S1, REPORTED ratio; units TUNED |
| Throw tech window | 7 frames after the grab connects; teching pushes both apart 40 units and leaves both 14 frames in tech | S3, REPORTED window; push TUNED |
| Throw clash | both throwing the same frame techs | S3, REPORTED |
| Throw invulnerable | airborne, prejump, knocked down, in hitstun or blockstun | S3, REPORTED |
| Knockdown | launched then lies 20 frames, invulnerable throughout | TUNED |
| Combo scaling | 100, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10 percent by hit number (floor 10) | S3, REPORTED shape; steps TUNED |
| Counter hit | hit during the defender's startup or active frames: +20% damage, +2 stun | S3, REPORTED |
| Punish counter | hit during the defender's recovery: +50% damage, +4 stun | S3, REPORTED |
| Hitstun lowers to knockdown | any hit on an airborne fighter, any `knockdown` move, any killing blow | S3, REPORTED |

## Gauges

| Gauge | Value | Source |
|---|---|---|
| Surge gauge (the drive-style gauge) | 60000, six bars of 10000, full at the start of each round | S2, REPORTED |
| Surge regen | 10 per frame while neutral and not overheated | TUNED |
| Deflect (parry) | costs 2500, active frames 2 to 13, a deflected strike gives 2000 back, the attacker is stuck 24 frames and the defender 4 | S2, REPORTED shape; numbers TUNED |
| Rush | costs 10000 raw or 30000 when cancelled from a connected normal; moves forward over frames 2 to 13 at 9 units per frame; a new attack may start from frame 11 | S2, REPORTED costs |
| Breaker (armoured) | costs 10000, startup 26, one hit absorbed on frames 5 to 24 (takes a quarter of the damage), hits for 800 and a long stun, blocked it drains 3500 | S2, REPORTED shape; frames TUNED |
| Blocking drains the gauge | per attack, listed in the move table | S2, REPORTED idea; amounts TUNED |
| Overheat | the gauge reaching zero by spending or by draining on block locks surge actions for 300 frames, then restores to 15000; while overheated every blocked hit does a quarter of its damage as chip, and chip can kill | S2, REPORTED idea; numbers TUNED |
| Chip damage | specials and projectiles do 1/8 (the super 1/6) of damage when blocked, normals none; chip cannot kill outside overheat | S3, REPORTED shape |
| Super meter | 30000, three bars; level 1 super costs 10000 | S3, REPORTED |
| Super gain | the attacker gains the move's value on hit and half on block; the defender gains half the value when hit | S3, REPORTED shape; values TUNED |

## Move table (one original all-rounder)

Stand, crouch and air normals, a throw, two specials, a level 1 super and three surge actions. The
`Source` for every row is S1 (S2 for the surge rows), REPORTED unless the cell says TUNED. Names
are original.

| Name | Key | Start | Active | Recov | Damage | Adv hit | Adv block | Stun hit | Stun block | Hitstop | Level | Block drain | Meter |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Quick (stand light) | standLight | 4 | 2 | 6 | 300 | +4 | +1 | derived | derived | 8 | mid | 1000 | 250 |
| Drive (stand medium) | standMedium | 6 | 3 | 12 | 600 | +5 | 0 | derived | derived | 10 | mid | 1500 | 350 |
| Smash (stand heavy) | standHeavy | 10 | 3 | 18 | 900 | +3 | -2 | derived | derived | 12 | mid | 2000 | 500 |
| Axe (forward heavy, overhead) | forwardHeavy | 24 | 3 | 14 | 700 | +4 | -4 | derived | derived | 11 | high | 1800 | 400 |
| Low Quick (crouch light) | crouchLight | 4 | 2 | 7 | 250 | +4 | +1 | derived | derived | 8 | low | 1000 | 200 |
| Low Drive (crouch medium) | crouchMedium | 7 | 3 | 13 | 500 | +4 | -1 | derived | derived | 10 | low | 1500 | 300 |
| Sweep (crouch heavy) | crouchHeavy | 9 | 3 | 22 | 800 | knockdown | -12 | n/a | derived | 12 | low | 2000 | 450 |
| Air Quick | airLight | 5 | 8 | 0 | 400 | n/a | n/a | 17 | 11 | 8 | high | 1000 | 200 |
| Air Drive | airMedium | 7 | 6 | 0 | 700 | n/a | n/a | 20 | 14 | 10 | high | 1500 | 300 |
| Air Smash | airHeavy | 9 | 5 | 0 | 900 | n/a | n/a | 22 | 16 | 12 | high | 2000 | 450 |
| Grab (throw) | throw | 5 | 2 | 22 | 1200 | knockdown | n/a | n/a | n/a | 0 | mid | 0 | 800 |
| Spark (projectile) | spark | 13 | 1 | 39 | 600 | n/a | n/a | 22 | 16 | 8 (defender only) | mid | 2500 | 400 |
| Riser (anti-air, invulnerable to strikes and projectiles on frames 1 to 6) | riser | 3 | 6 | 30 | 1100 | knockdown | -30 | n/a | derived | 12 | mid | 2500 | 500 |
| Ember Wave (level 1 super projectile) | ember | 8 | 1 | 36 | 2100 | knockdown | n/a | 40 | 22 | 14 (defender only) | mid | 3500 | 0 |
| Deflect | deflect | 2 | 12 | 14 | 0 | n/a | n/a | n/a | n/a | 0 | n/a | 0 | 0 |
| Rush | rush | 1 | moves 2 to 13 | total 16 | 0 | n/a | n/a | n/a | n/a | 0 | n/a | 0 | 0 |
| Breaker | breaker | 26 | 3 | 24 | 800 | n/a | n/a | 36 | 18 | 14 | mid | 3500 | 400 |

Projectile data: the Spark moves 6 units per frame and the Ember Wave 9 (TUNED), one projectile per
fighter, two projectiles that meet cancel each other, and a projectile ignores a fighter who is
invulnerable to it. Pushback on hit and block is TUNED (10 to 20 units on hit, 12 to 30 on block),
applied to the defender, or to the attacker when the defender is against the wall.

How the controls map (one scheme for humans and agents, like Modern controls):

- Direction: 8 directions plus neutral, absolute on screen. Forward and back follow the facing.
- Buttons: light, medium, heavy, special, surge, and throw (light plus medium together). One
  button state per frame; a press is a change to a new button, so releasing before pressing again
  is required.
- Heavy with forward is the overhead. Any attack with down held is a crouching attack (low).
- Special: neutral, forward or back is the Spark; any up direction is the Riser; down with a full
  bar of super meter is the Ember Wave.
- Surge: neutral or back is Deflect; forward is Rush; down is Breaker.
- Specials, Rush and the super cancel a normal that has hit or been blocked.

## Hitboxes and hurtboxes

All boxes are in unit coordinates relative to the feet, facing right, flipped by facing.

- Hurtboxes: stand x -26 to 26, y 0 to 170; crouch x -28 to 28, y 0 to 105; airborne x -26 to 26,
  y 20 to 160 above the feet. From its first active frame, a limb hurtbox equal to the hitbox is
  added, and it stays for a few frames of recovery so a whiffed poke can be punished by reaching
  the limb: Quick 3, Drive 5, Smash 8, Axe 6, Low Quick 3, Low Drive 5, Sweep 10 frames after the
  last active frame (`limbExtra` in `frame-data.ts`). Air normals have no recovery limb. TUNED.
- Hitboxes (one box per move, live on the active frames only):
  Quick x 20..100 y 90..140; Drive x 20..125 y 80..140; Smash x 20..150 y 60..130;
  Axe x 10..110 y 60..178; Low Quick x 20..95 y 10..45; Low Drive x 20..130 y 0..45;
  Sweep x 20..170 y 0..35; Air Quick x 10..80 y 40..110; Air Drive x 10..100 y 30..110;
  Air Smash x 0..110 y 10..120; Riser x 8..75 y 0..210; Breaker x 20..130 y 30..150.
  Spark box is 44 by 36 around the projectile, Ember Wave 60 by 56. TUNED.
- Invulnerability: knockdown and thrown are invulnerable to everything; prejump to throws; back
  dash frames 1 to 6 to everything; Riser frames 1 to 6 to strikes and projectiles.

## What the sim exposes to renderers and agents

- Per fighter: `moveId`, `moveFrame`, `facing`, `pos`, `vel`, `hitstop`, `stun`, and an `events` bit
  mask for the frame (hit taken, blocked, deflected, thrown, teched, knockdown, landed, projectile
  fired, overheat, armour, ko, move start). Renderers map `moveId` and `moveFrame` to animation
  clips; `MOVES[moveId]` gives startup, active and total frames.
- Observations are mirrored so each seat sees itself on the left facing right; 142 floats per seat
  (`fighterEncoder`). The self view also carries its own input state (previous button and buffered
  button as 7-way one-hots, buffer age, the buffered direction as forward, back, up and down flags relative to facing, forward and back dash taps), because a button only fires
  on a change and a dash needs the tap state; this adds 21 floats, so 142 in all.

## Training under human limits (R15, observation v2)

The Easy, Medium and Hard fighters are trained and played behind the `HumanLimiter` (delay, press cap, minimum
hold). The first version of that stage collapsed: a near-uniform policy could not see its own press budget, so it
spent the cap in the first seconds of every minute and was frozen afterwards (plan/audit-fighter.md). So:

- A press, for the cap, is only a NEW input: a direction that differs from the held one and is not neutral, or a
  button that is newly down. Releasing a button or the direction is free, and so is keeping the held input.
- The policy sees its own hands without delay, appended after the delayed view: the held direction (in the
  seat's own view, nine-way one-hot), the held button (seven-way one-hot), the fraction of the press window still
  free, frames since the last accepted change (capped at two seconds), and a flag that the last proposal was
  refused. 19 floats, so 162 per seat in the training env (`OBS_FEATURES`).
- The button head has an eighth value, KEEP, that holds the current input. It is never refused and costs nothing.
- Below Champion, scripted bots read the same delayed view as the agent and play under the same limits. At
  Champion (and with no level) they see the live game, which is the bar Champion is measured against.
- Stage B anneals its entropy bonus from 0.01 to 0.001 and, every 2M steps, plays the snapshot against the
  scripted bots (both seats, first k matches per env). A pass is saved under `gated/` and listed in
  `levels/gated.json`; T25 measures the listed weights with 400 matches per bot.
- The publish bars (Wilson 95% lower bounds, 400 matches per bot, learner on both seats, bots under the same
  limits and delayed view): Hard 0.60 against rushdown and turtle and 0.95 against random; Medium 0.50 and 0.90;
  Easy 0.35 and 0.85; Champion 0.75 against bots that see the live game. A level below its bar shows "in training".

## What this version leaves out

No super freeze or flash, no wall splat, no air juggles (a knocked-down fighter is untouchable),
no throw escapes after the tech window, no corner-specific pushback rules, no input leniency for
shortcut commands, and a single hitbox per move. Each is a candidate for a later version and would
change `version` in `core.ts` (records pin the core version).
