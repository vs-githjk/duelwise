# Retune: how a level's strength against people is estimated

Code: `packages/agents/src/measure/people.ts`. Tests: `people.test.ts`, `registry-rows.test.ts`. Plan: D1 and D2 of the Nov 10 2026 retune plan.

## The question
What share of matches does each level win against an ordinary Duelwise player? Score per match, a draw counts half.
"Ordinary" means human traffic (guests and signed in), with owner and test traffic excluded.

## Bands (D1), as the AI's score
| Level | Band |
|---|---|
| Pip (easy) | 42 to 58% |
| Marlow (medium) | 65 to 75% |
| Vesper (hard) | 80 to 90% |
| Sable (champion) | 93% or more |

`PEOPLE_BANDS` is the one source in code.

## Three sources, in order of trust
1. **Real matches.** `plan/retune/human-baseline.csv`, one row per game and level, columns
   `game,level,matches,players,ai_points,as_of` (`ai_points`: win 1, draw 0.5, a resign or abandon by the person 1).
   Counted only from 40 matches by at least 10 different players for that level. When its Wilson interval sits wholly
   outside the band, it wins: `calibrated` equals the real score.
2. **The panel.** Three test players per game (beginner, average, strong), weighted 30 / 50 / 20 (D2), each with the
   hands, reaction and mistakes a person has in the browser. `estimate` is the weighted score; `ci95` combines the three
   intervals. Each test player gets a plain description in `proxies`, shown in the report.
3. **Calibration.** The per-game gap (real minus panel, weighted by matches, over the levels that meet the minimum) is added to
   the panel estimate, shrunk by `n / (n + 40)` so a thin sample moves it little.

## Verdicts
`in-band`, `below`, `above` by the calibrated score against the band. `ceiling` is `below` plus a `ceiling` block: the
strongest settings tried, against the average test player, and the score they reached, which must itself fall short of the
band. A ceiling without that block is refused, in code and in the registry check.

## Rules
- The `people` block in a registry is written by measure scripts only, next to the ladder results. `registry-rows.test.ts`
  recomputes every block from its own parts, so a hand edit fails.
- Tuning changes a level's published settings, the same for everyone. Nothing reads the score or the player.
- The block is optional until A9, then required for every published level.
- No percentage against people goes on the site before 100 real matches at that level (D10).
