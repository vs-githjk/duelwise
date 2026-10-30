# Arena: movement, weapons and round rules

Headless sim in `packages/core/src/games/arena/` (task T9). 60 Hz fixed step, deterministic from
(seed, inputs), first-person 1v1 with hitscan weapons. The numbers are tuned from public movement
and weapon data of a modern tactical shooter so the feel carries over; every weapon, map, name and
the geometry are original. This file may name the reference game as a source; product copy never
does.

Record compatibility: the core version is `arena-2`. The input packing changed (the yaw radix grew to carry human mouse turns up to 45 degrees a frame), so records made before `arena-2` do not replay; `replay` rejects them with `core version mismatch`.

## How to read the sources

- REPORTED: recalled from the public community documentation and rounded to a clean value. Not
  re-read from the page during this task (no page was fetched), so treat each as a design target
  and confirm against the page before quoting it outside the repo.
- ENGINE: the standard Source-engine movement equations (friction, accelerate, air accelerate),
  re-implemented from their public descriptions. No Valve code is copied.
- TUNED: chosen by us for this sim (no public equivalent, or it depends on our map and art).

Source pages (all public):

- S1 Console variables for movement (`sv_accelerate`, `sv_friction`, `sv_stopspeed`, `sv_airaccelerate`, `sv_gravity`): https://developer.valvesoftware.com/wiki/List_of_Counter-Strike:_Global_Offensive_Cvars
- S2 Source movement equations (ground friction, accelerate, air accelerate with the 30 unit wish cap): https://adrianb.io/2015/02/14/bunnyhop.html
- S3 Weapon statistics (damage, armor penetration, range modifier, cycle time, magazine, reload, movement speed, price, kill reward): https://liquipedia.net/counterstrike/Weapons
- S4 Damage rules (hit group multipliers, armor formula, range falloff per 500 units): https://counterstrike.fandom.com/wiki/Damage
- S5 Economy (start money, round rewards, loss bonus ladder, money cap): https://liquipedia.net/counterstrike/Economy
- S6 Player hull, eye height, jump height and accuracy rules (first shot accurate below about a third of max speed): https://developer.valvesoftware.com/wiki/Dimensions

## Conventions

- Units are world units (1 unit is about 2.5 cm). x and y span the floor, z is up, the floor is z = 0.
- Angles are integers: 8192 units per full turn (0.044 degrees). Yaw 0 looks along +x and grows
  towards +y. Pitch 0 looks level and grows upwards, clamped to +-1900 (about 83.5 degrees).
  Sine and cosine come from a quarter-wave table (2049 entries, `trig.ts`, generated once and
  committed), so no libm call ever touches state.
- A frame is 1/60 s (`DT = 1/60`, one IEEE division).
- Actions are one integer per seat per frame, 0 is neutral. Per frame: 8-way move, walk, crouch,
  jump, fire, reload, yaw delta in -1024..1024 (at most 45 degrees per frame, so no human flick is cut short; R30), pitch delta in
  -127..127, and a buy choice (only used in the buy phase). Pack size is under 1.3e9, inside Int32. Agents and bots stay
  within -255..255 (`YAW_MAX`, 11.2 degrees per frame) through their action heads and their limiter; only a human's mouse uses the wider range.

## Movement

| Rule | Value | Source |
|---|---|---|
| Max run speed | per weapon: pistol 240, rifle 215, carbine 225 u/s | S3, REPORTED |
| Walk factor | 0.52 of max | S1, REPORTED |
| Crouch factor | 0.34 of max | S1, REPORTED |
| Ground acceleration | 5.5: each frame adds `5.5 * DT * wishspeed` along the wish direction, never past `wishspeed - currentspeed` | S1, S2, ENGINE |
| Ground friction | 5.2: each frame removes `max(speed, 80) * 5.2 * DT` (stop speed 80) | S1, S2, ENGINE |
| Air acceleration | 12, wish speed capped at 30 for the add-speed test; no friction | S1, S2, ENGINE |
| Gravity | 800 u/s^2 | S1, REPORTED |
| Jump impulse | 301.993 u/s (peak about 57 units), jump needs a fresh press (no auto bunny hop) | S6, REPORTED (press edge TUNED) |
| Diagonal input | wish direction normalised, never faster than straight | ENGINE |
| Hull | 32 x 32 footprint, 72 tall standing, 54 crouched, eye 64 standing, 46 crouched | S6, REPORTED |
| Crouch | instant, no duck animation | TUNED |
| Step height | 18 units: a box edge up to 18 above the feet is stepped onto | S6, REPORTED |
| Player vs player | the other living seat's hull blocks movement, so hulls never overlap (a landing on a head may walk out); a shot whose eye is inside the opponent's hull scores nothing | TUNED |

A counter-strafe (tapping the opposite direction) stops faster than releasing keys because the
opposite wish direction adds acceleration on top of friction. Both effects are measured in
`arena.test.ts` against the running sim.

## Accuracy and recoil

| Rule | Value | Source |
|---|---|---|
| Accurate speed | the first shot of a spray is exact on the ground while speed is at most 0.34 of the weapon max speed (plus 0.5 u/s float margin) | S6, REPORTED |
| Moving spread | tangent-space spread `moveSpread * speed / maxSpeed` once above the threshold: rifle 0.07, carbine 0.065, pistol 0.05 (at 800 units 0.07 is about 56 units, wider than the hull) | TUNED |
| Air spread | 0.12 | TUNED |
| Spray spread | `fireSpread * min(shotIndex, 10)`: rifle 0.0012, carbine 0.001, pistol 0.002 per step; the first shot adds none | TUNED |
| Spread sampling | uniform in a disc from the seeded core Rng (rejection sampling) | TUNED |
| Recoil pattern | fixed per weapon, 30 entries for rifle and carbine (pitch then yaw increments in angle units); the shot reads the punch before adding its own, so shot 1 is always on the aim point | S3, REPORTED (shape); numbers TUNED |
| Pattern shape | rifle: a straight climb for 9 shots (about 7 degrees up), a swing left, a larger swing right, a swing left again | REPORTED (shape) |
| Recoil reset | the shot index returns to 0 after 20 frames (rifle, carbine) or 12 (pistol) without firing | TUNED |
| Punch recovery | held while the weapon is cycling, then the punch is multiplied by 0.9 per frame and snapped to 0 below 0.05 units | TUNED |

The agent sees its own punch in the observation, so it can learn to pull down against the pattern.

## Damage

Weapons are original; the numbers follow the class each is modelled on.

| Weapon | Class | Price | Damage | Armor pen | Range mod | Cycle | Magazine | Reload | Fire mode | Kill reward |
|---|---|---|---|---|---|---|---|---|---|---|
| Dart | pistol | 0 | 35 | 0.505 | 0.79 | 9 frames | 12 | 132 frames | semi | 300 |
| Ridgeline | rifle | 2700 | 36 | 0.775 | 0.98 | 6 frames | 30 | 150 frames | auto | 300 |
| Carbine | rifle | 3100 | 33 | 0.70 | 0.97 | 5 frames (5.45 in the model, rounded) | 30 | 186 frames | auto | 300 |

Sources S3 (REPORTED). Armor costs 1000 for vest and helmet together (S3, S5, REPORTED). Buying a
primary replaces the pistol (one weapon at a time, TUNED).

- Hit groups on the hull by height fraction: head from 0.86, chest from 0.57, stomach from 0.36,
  legs below. Multipliers head 4.0, chest 1.0, stomach 1.25, legs 0.75 (S4, REPORTED; fractions TUNED
  to the 72 unit hull).
- Range falloff: `damage * rangeMod ^ (distance / 500)`, computed as repeated multiplication plus a
  linear blend for the fractional part, so no pow call is used (S4, REPORTED; blend TUNED).
- Armor (head, chest and stomach only, legs are never protected): `toHealth = damage * pen`,
  `armorLoss = (damage - toHealth) * 0.5`; if the armor runs out, `toHealth = damage - armor * 2` and
  armor becomes 0 (S4, REPORTED). Health and armor are rounded to integers after each hit.
- Bullets are hitscan, stopped by any box. There is no wall penetration (TUNED, deferred).
- Two seats shooting in the same frame both resolve against the positions at the end of movement,
  so a trade is possible and neither seat has a seat-order advantage.

## Rounds and economy

| Rule | Value | Source |
|---|---|---|
| Health | 100, reset each round | S3, REPORTED |
| Buy phase | 600 frames (10 s) with no movement or firing, aim still free; `buyFrames` option shortens it | TUNED (reference freeze time is longer) |
| Round timer | 3600 frames (60 s) | TUNED (reference is 115 s on a larger map) |
| Timer expiry | more health wins; equal health is a drawn round | TUNED |
| Both die in one frame | drawn round | TUNED |
| Round end pause | 180 frames | TUNED |
| First to | 7 round wins; at most 13 rounds, then the higher score wins or the match is a draw | TUNED |
| Start money | 800 | S5, REPORTED |
| Round win | 3250 | S5, REPORTED |
| Loss bonus | 1400 plus 500 per loss already in the streak, streak capped at 4 (so 1400 up to 3400); a win lowers the streak by 1; a drawn round pays both seats the loss bonus | S5, REPORTED (draw TUNED) |
| Kill reward | 300 (all three weapons) | S3, REPORTED |
| Money cap | 16000 | S5, REPORTED |
| Carry over | a survivor keeps weapon and remaining armor; a dead seat falls back to the pistol and no armor; magazines are refilled | TUNED |
| No sides swap | seats keep their spawn side pairs, picked per round by the seeded Rng | TUNED |

Buy choices (buy phase only, one purchase per frame, ignored when unaffordable or already owned):
1 Ridgeline, 2 Carbine, 3 armor.

## Observation

`arenaEncoder` reads only what the seat may know:

- Own state: health, armor, money, velocity in the view frame, height, crouch, ground flag, pitch,
  yaw as sine and cosine, absolute position and map id, weapon, ammo, reload and cooldown, recoil
  index and punch.
- Opponent: only when it is alive, inside a 106 degree horizontal field of view and at least one of
  three body points (head, chest, legs) is not blocked by a box. Otherwise the last seen position,
  velocity and age in frames (0 means seen this frame, saturates at 600), or "never seen this round".
  Vertical field of view is not limited (TUNED).
- Crosshair offset to the opponent (T10, only when it is known; zeros otherwise): an ahead flag, the yaw
  error as sin(angle) both as is and times 8, and the pitch error in radians (recoil included) times 2
  and times 12, all clamped to -1..1. Computed from cross products, so a network reads the aiming
  error directly instead of having to derive it from two distances.
- 24 distance rays, evenly spaced around the view yaw, cast horizontally at 30 units above the
  feet (so low cover at 40 blocks them), capped at 2000.
- Phase, timer, round, scores.

## Maps

`maps/duel-1.json` and `maps/duel-2.json` are shared with the renderer: a bounds rectangle, a wall
height, axis-aligned boxes (`wall` full height, `cover` 40 high for peeking and crouch cover) and
spawn pairs. The loader adds four outer walls. Every spawn pair has no line of sight at the start
of a round (tested).

## Training env, bots and human-like limits (T10)

All of this is the builder's design (TUNED, no external source); nothing here changes the sim.

- Decisions: one every 4 frames (15 per second), the input held for the 4 frames. The buy phase is
  2 decisions (a weapon choice, then armor), after which the rest of the phase and the round-end
  frames are skipped, so a policy never spends 600 decisions standing in the buy zone.
- Action heads (Int32, nine per seat): move (9), walk, crouch, jump, fire, reload (2 each), yaw bin
  (9: -200, -100, -40, -12, 0, 12, 40, 100, 200 angle units per frame), pitch bin (7: -60, -20, -5, 0,
  5, 20, 60), buy (4: none, ridgeline, carbine, armor). The bins only shape what a network can output;
  the sim still takes any delta the mouse can make.
- Trigger: a semi-automatic weapon (the dart pistol) fires on the first frame of a decision at most, so
  every decision with fire set is a fresh press; an automatic weapon keeps the trigger down for the
  whole decision. The policy has no memory of its last trigger state, so this is what lets it fire
  on every decision it chooses to.
- Reward (seat 0 view, per decision): (damage dealt - damage taken) / 100 during live frames, plus
  1 for each round won and -1 for each round lost; a drawn round pays 0. Plus a potential-based aiming
  term (Ng, Harada and Russell 1999, so the best policy does not change): the potential is 0.2 times the
  mean of a yaw and a pitch alignment (1 on target, 0 at 0.5 rad of error) while the opponent is in
  sight, 0 otherwise; the reward adds 0.99 times the next potential minus the current one. Without it a
  fresh policy that has never landed a shot sees no signal for the first millions of steps (measured in
  the first smoke: 0 of 208 rounds won after 5.6M steps).
- Human-like levels (limiter.ts): the movement and button input goes through the APM cap and minimum
  hold; the turn is clamped to the level's rate (Easy 180, Medium 300, Hard 540 degrees per second,
  Champion none) and jittered by up to the level's noise (6, 3, 1.5, 0 degrees) over the decision,
  scaled by how close the command is to the cap. A zero turn never jitters.
- Close-range curriculum (level suffix `@close`): at the start of every round seat 0 is moved to
  350, 500 or 700 units from seat 1 (first free spot with a clear line of sight, searching around
  seat 1 in 30 degree steps) and faces it, so a young policy meets its opponent in a few decisions.
  The trainer runs it for the first steps of stage A only.
- Scripted bots: `random` (uniform over the policy heads, exactly an untrained network), `rusher`
  (buys the best weapon it can afford, then armor; closes in strafing, tracks the opponent with
  recoil compensation, fires when on target), `holder` (same shopping; crouches and walks, tracks and
  fires three-decision bursts, sweeps when it has not seen the opponent). Bots see the same
  observation an agent does. R30 adds the human-proxy bots the judge used: `peeker` (crouched at its start, then a
  short strafing peek that fires on sight, side alternating), `strafe` (counter-strafing: three decisions of sideways
  running, three stopped and firing) and `holdangle` (stands still on one angle and fires when the opponent crosses it).
  They are appended to the bot list, so the sentinels of the first three do not change.
- Training under human limits (R15, observation v2): the same lessons as the fighter (docs/game-design/fighter.md).
  A press for the APM cap is a new move direction or a newly set flag (walk, crouch, jump, fire, reload); clearing a
  flag or the move is free. The observation appends 17 own-input floats, undelayed: the held move (nine-way
  one-hot), the five held flags, the fraction of the press window free, frames since the last accepted change and a
  refused flag. The move head has a tenth value, KEEP, that keeps the held move and flags at no APM cost (the turn
  and buy heads still apply). Below Champion the scripted bots see the opponent as late as the agent does but know their own
  position, aim and ammo live, like a person (R30: the first gate delayed the bot's own crosshair as well, so the bots could not aim and
  Easy and Hard "beat" them 400 to 0 while losing 20 of 20 to a scripted human proxy). The
  trainer's in-run gate counts rounds (a match is about 15 rounds); the publish bars are the fighter's, measured in
  matches by T26. The arena's real stage B schedule (ratified in R27): entropy bonus annealed 0.002 to 0.0005, gate
  every 3M steps.
