import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { SHIPS, shipCells, type FleetState, type Placement } from '@duelwise/core/src/games/fleet/core'
import { fleetLuckLine, luckScore } from '../games/fleet/luck'
import { isHumanLoss, nearMiss, NOT_CLOSE, type NearMiss } from './near-miss'
import type { Moment } from './types'
import { walk } from './walk'

// Stormglass (internal id fleet) report. Built only from the stored record: the setup is five place actions per seat, the
// shots follow. Nothing here prints a coordinate or a ship position, so a shared report never shows anyone's setup.

interface Facts {
  state: FleetState
  setupDone: boolean
  over: boolean
  myShots: number[]
  theirShots: number[]
  myLeft: number
  theirLeft: number
  enemy: Placement[]
}

function factsOf(rec: MatchRecordV1): Facts {
  const steps = walk<FleetState, unknown>(rec)
  const state: FleetState = steps.length > 0 ? steps[steps.length - 1]!.after : { ships: [[], []], shots: [[], []] }
  const me = rec.humanSeat
  const them = (1 - me) as 0 | 1
  const setupDone = state.ships[0].length === SHIPS.length && state.ships[1].length === SHIPS.length
  const afloat = (target: Placement[], shots: number[]) => target.filter((p) => !shipCells(p).every((c) => shots.includes(c))).length
  const myLeft = afloat(state.ships[me], state.shots[them])
  const theirLeft = afloat(state.ships[them], state.shots[me])
  return {
    state,
    setupDone,
    over: setupDone && (myLeft === 0 || theirLeft === 0),
    myShots: state.shots[me],
    theirShots: state.shots[them],
    myLeft,
    theirLeft,
    enemy: state.ships[them],
  }
}

/** The ship the player took longest to finish after the first hit: shots from first hit to sinking against the fewest it can take. */
function slowestFinish(shots: number[], target: Placement[]): { length: number; took: number; wasted: number } | null {
  let worst: { length: number; took: number; wasted: number } | null = null
  for (const p of target) {
    const idx = shipCells(p).map((c) => shots.indexOf(c))
    if (idx.some((i) => i < 0)) continue
    const took = Math.max(...idx) - Math.min(...idx)
    const wasted = took - (p.length - 1)
    if (!worst || wasted > worst.wasted) worst = { length: p.length, took, wasted }
  }
  return worst
}

/** Key moments for a fleet match: shots used, ships left, the luck line, the slowest finish, then the result. */
export function fleetMoments(rec: MatchRecordV1, sentence: string, opponent: string): Moment[] {
  const f = factsOf(rec)
  const end: Moment = { kind: 'end', label: 'Result', tag: 'how it ended', text: sentence }
  if (!f.setupDone) return [end]
  const out: Moment[] = []
  const youShots = f.myShots.length
  const themShots = f.theirShots.length
  const noun = youShots === 1 ? 'shot' : 'shots'
  out.push({
    kind: 'info',
    label: 'Shots used',
    tag: 'both sides',
    text: `You fired ${youShots} ${noun}; ${opponent} fired ${themShots}.`,
    publicText: `The player fired ${youShots} ${noun}; ${opponent} fired ${themShots}.`,
    value: String(youShots),
    valueLabel: 'shots',
  })
  out.push({
    kind: 'info',
    label: 'Ships left',
    tag: 'at the end',
    text: `You finished with ${f.myLeft} of ${SHIPS.length} ships afloat; ${opponent} had ${f.theirLeft}.`,
    publicText: `The player finished with ${f.myLeft} of ${SHIPS.length} ships afloat; ${opponent} had ${f.theirLeft}.`,
    value: `${f.myLeft} of ${SHIPS.length}`,
    valueLabel: 'afloat',
  })
  const found = SHIPS.length - f.theirLeft
  if (f.over && found > 0) {
    const won = f.theirLeft === 0
    const input = {
      won,
      winnerShots: won ? youShots : themShots,
      found,
      score: luckScore(f.myShots, f.enemy),
      opponent,
    }
    out.push({ kind: 'info', label: 'Luck', tag: 'hits against chance', text: fleetLuckLine(input), publicText: fleetLuckLine({ ...input, third: true }) })
  }
  const slow = slowestFinish(f.myShots, f.enemy)
  if (slow) {
    const slowOne = slow.wasted > 0
    out.push({
      kind: slowOne ? 'worst' : 'best',
      label: `The ${slow.length}-long ship`,
      tag: slowOne ? 'slowest finish' : 'cleanest finish',
      text: slowOne
        ? `It took ${slow.took} shots from the first hit to sink it; ${slow.length - 1} is the fewest it can take. After a hit, fire along the line before you search again.`
        : 'Every ship you sank went down in the fewest shots after the first hit.',
      publicText: slowOne
        ? `It took ${slow.took} shots from the first hit to sink it; ${slow.length - 1} is the fewest it can take.`
        : 'Every ship the player sank went down in the fewest shots after the first hit.',
    })
  }
  return [...out, end]
}

/** The most unhit cells that still count as close: a ship's worth, no more. */
export const CLOSE_CELLS = 3

/**
 * Stormglass's near miss: a lost game in which the player was within three hits of sinking the whole fleet. Counts only, from the replayed shots: no
 * coordinate and no ship position, so a shared report still shows no one's setup.
 */
export function fleetNearMiss(rec: MatchRecordV1, opponent: string): NearMiss | null {
  if (!isHumanLoss(rec)) return null
  const f = factsOf(rec)
  if (!f.over || f.myLeft !== 0 || f.theirLeft === 0) return null
  const unhit = f.enemy.flatMap((p) => shipCells(p).filter((c) => !f.myShots.includes(c)))
  const cellsLeft = unhit.length
  if (cellsLeft > CLOSE_CELLS) return NOT_CLOSE
  const hits = `${cellsLeft} ${cellsLeft === 1 ? 'hit' : 'hits'}`
  const target = f.theirLeft === 1 ? 'the last ship' : `the last ${f.theirLeft} ships`
  const sunk = SHIPS.length - f.theirLeft
  const shots = f.myShots.length
  return nearMiss(true, {
    turning: `You were ${hits} from sinking ${target}.`,
    publicTurning: `The player was ${hits} from sinking ${target}.`,
    line: `${opponent} sank your last ship on shot ${f.theirShots.length}; you had fired ${shots}.`,
    publicLine: `${opponent} sank the player's last ship on shot ${f.theirShots.length}; the player had fired ${shots}.`,
    stats: [
      { label: cellsLeft === 1 ? 'Hit short' : 'Hits short', value: cellsLeft },
      { label: sunk === 1 ? 'Ship sunk' : 'Ships sunk', value: sunk },
      { label: shots === 1 ? 'Shot fired' : 'Shots fired', value: shots },
    ],
  })
}
