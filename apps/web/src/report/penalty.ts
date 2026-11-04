import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { KICKS, penaltyCore, type PenaltyState } from '@duelwise/core/src/games/penalty/core'
import { DIVE_LABEL, outcomeWord, zoneWord } from '../games/penalty/match'
import type { Moment, PenaltyKickRow, PenaltyView } from './types'
import { walk } from './walk'

// Twelve Yards report. Built only from the stored record: every kick is replayed through the core, so each count below (where you aimed, how often the
// keeper went your way, your saves, who led after each kick) is read off the kicks, never guessed about who played well. A shootout of five kicks each
// is short, so nothing here is called a pattern unless it repeated: three of five, not two.

/** The fewest of the player's kicks that can show a habit, and the repeats that count as one. */
export const HABIT_MIN_KICKS = 3
export const HABIT_MIN_REPEATS = 3

const SIDE_NAME = ['on the left', 'down the middle', 'on the right'] as const
const ROW_NAME = ['high', 'at mid height', 'low'] as const

export interface PenaltyReport {
  moments: Moment[]
  view: PenaltyView | null
  /** The player's own kicks, for the tile and the share card. */
  yourKicks: number
  note: string | null
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const spot = (z: number): string => (z === 4 ? 'down the middle' : zoneWord(z))
/** Left (0), middle (1) or right (2), as the shooter sees the goal. */
const sideOfZone = (z: number): 0 | 1 | 2 => (z % 3) as 0 | 1 | 2
/** The side a dive covers: left (0), the stay (1) which holds the middle, or right (2). */
const sideOfDive = (d: number): 0 | 1 | 2 => (d === 2 ? 1 : d < 2 ? 0 : 2)

function rowsOf(state: PenaltyState, human: 0 | 1): PenaltyKickRow[] {
  return state.kicks.map((k, i) => {
    const w = outcomeWord(k)
    const round = Math.floor(i / 2) + 1
    return { n: i + 1, round, sudden: round > KICKS, byMe: k.kicker === human, zone: k.zone, dive: k.dive, outcome: w === 'Goal' ? 'goal' : w === 'Saved' ? 'saved' : w === 'Over' ? 'over' : 'wide' }
  })
}

/**
 * What the player's own kicks show, in one sentence, or null when there are too few. A repeated spot comes first (that is what a keeper can read);
 * then a repeated side of the goal, then a repeated height. A spread-out set of kicks says so rather than inventing a habit.
 */
export function habitSentence(zones: readonly number[], owner = true): { text: string; repeated: boolean } | null {
  const you = owner ? 'You' : 'The player'
  const n = zones.length
  if (n < HABIT_MIN_KICKS) return null
  const count = (f: (z: number) => number, size: number): number[] => {
    const c = new Array<number>(size).fill(0)
    for (const z of zones) c[f(z)]!++
    return c
  }
  const byZone = count((z) => z, 9)
  const topZone = byZone.indexOf(Math.max(...byZone))
  if (byZone[topZone]! >= HABIT_MIN_REPEATS) return { text: `${you} went ${spot(topZone)} ${byZone[topZone] === n ? `every time, ${n} of ${n}` : `${byZone[topZone]} of ${n} times`}.`, repeated: true }
  const bySide = count(sideOfZone, 3)
  const topSide = bySide.indexOf(Math.max(...bySide))
  if (bySide[topSide]! >= HABIT_MIN_REPEATS && bySide[topSide]! / n >= 0.6) return { text: `${you} aimed ${SIDE_NAME[topSide]} of the goal ${bySide[topSide]} of ${n} times, at ${plural(new Set(zones.filter((z) => sideOfZone(z) === topSide)).size, 'spot', 'spots')}.`, repeated: true }
  const byRow = count((z) => Math.floor(z / 3), 3)
  const topRow = byRow.indexOf(Math.max(...byRow))
  if (byRow[topRow]! >= HABIT_MIN_REPEATS && byRow[topRow]! / n >= 0.6) return { text: `${you} aimed ${ROW_NAME[topRow]} ${byRow[topRow]} of ${n} times.`, repeated: true }
  return { text: `No habit showed: ${owner ? 'your' : "the player's"} ${n} kicks went to ${new Set(zones).size} different spots.`, repeated: false }
}

export function penaltyReport(rec: MatchRecordV1, sentence: string, opponent: string): PenaltyReport {
  const steps = walk<PenaltyState, number>(rec)
  const last = steps.at(-1)?.after
  // A resigned or unfinished record ends on a shootout nobody finished: the result alone, never counts of an unfinished one.
  const finished = last !== undefined && penaltyCore.terminal(last)
  if (!finished) return { moments: [{ kind: 'end', label: 'Result', tag: 'how it ended', text: sentence }], view: null, yourKicks: 0, note: null }
  const human = rec.humanSeat
  const rows = rowsOf(last, human)
  const mine = rows.filter((r) => r.byMe)
  const theirs = rows.filter((r) => !r.byMe)
  const goals: [number, number] = [mine.filter((r) => r.outcome === 'goal').length, theirs.filter((r) => r.outcome === 'goal').length]
  const sudden = rows.some((r) => r.sudden)
  const view: PenaltyView = { kicks: rows, goals, youFirst: human === 0, sudden }

  const moments: Moment[] = []
  const habit = habitSentence(mine.map((r) => r.zone))
  if (habit) {
    moments.push({
      kind: habit.repeated ? 'info' : 'best',
      label: 'Your kicks',
      tag: 'what a keeper could read',
      text: habit.text,
      publicText: habitSentence(mine.map((r) => r.zone), false)!.text,
      value: `${goals[0]} of ${mine.length}`,
      valueLabel: 'scored',
    })
  }
  // How often the keeper went your way: the same side, or the stay for a shot at the middle column.
  if (mine.length >= HABIT_MIN_KICKS) {
    const same = mine.filter((r) => sideOfDive(r.dive) === sideOfZone(r.zone))
    const read = same.length
    const scoredAnyway = same.filter((r) => r.outcome === 'goal').length
    const tail = (you: string) => (read === 0 ? '' : scoredAnyway === 0 ? ' None of those went in.' : ` ${you} still scored ${scoredAnyway} of ${read === 1 ? 'that one' : 'those'}.`)
    moments.push({
      kind: read * 2 > mine.length ? 'turning' : 'info',
      label: `${opponent} in goal`,
      tag: 'who guessed your side',
      text: `${opponent} went to the side you shot to on ${read} of your ${mine.length} kicks.${tail('You')}`,
      publicText: `${opponent} went to the side the player shot to on ${read} of the player's ${mine.length} kicks.${tail('The player')}`,
    })
  }
  if (theirs.length > 0) {
    const stopped = theirs.filter((r) => r.outcome === 'saved').length
    const missed = theirs.filter((r) => r.outcome === 'over' || r.outcome === 'wide').length
    const body = (you: string) => `${you} kept goal for ${plural(theirs.length, 'kick', 'kicks')}: ${stopped} saved, ${missed} missed by ${opponent}, ${goals[1]} scored.`
    moments.push({
      kind: stopped > 0 ? 'best' : 'info',
      label: 'Your gloves',
      tag: `${opponent}'s kicks`,
      text: body('You'),
      publicText: body('The player'),
      value: String(stopped),
      valueLabel: stopped === 1 ? 'save' : 'saves',
    })
  }
  if (sudden) {
    const lastRow = rows.at(-1)!
    moments.push({
      kind: 'turning',
      label: `Round ${lastRow.round}`,
      tag: 'sudden death',
      text: `It was level after five kicks each, so it went to sudden death and ended in round ${lastRow.round}.`,
    })
  }

  // Where the lead last changed hands: the last kick after which the score was not where the shootout ended (level counts as not ahead yet).
  const finalSign = Math.sign(goals[0] - goals[1])
  const leads: number[] = []
  let running = 0
  for (const r of rows) {
    if (r.outcome === 'goal') running += r.byMe ? 1 : -1
    leads.push(running)
  }
  let lastChange: PenaltyKickRow | null = null
  if (finalSign !== 0) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const before = i === 0 ? 0 : leads[i - 1]!
      if (Math.sign(before) !== finalSign) {
        lastChange = rows[i]!
        break
      }
    }
  }
  if (lastChange && lastChange.n < rows.length) {
    const ahead = finalSign > 0
    const ups = Math.abs(leads[lastChange.n - 1]!)
    const kickBy = lastChange.byMe ? null : `${opponent}'s`
    const kick = (yours: string) => `${kickBy ?? yours} ${spot(lastChange!.zone)} kick`
    moments.push({
      kind: 'turning',
      label: `Kick ${lastChange.n}`,
      tag: 'the lead changed for good',
      text: `${kick('Your')} put ${ahead ? 'you' : opponent} ahead for good, ${ups} up.`,
      publicText: `${kick("The player's")} put ${ahead ? 'the player' : opponent} ahead for good, ${ups} up.`,
    })
  }

  // The closing row repeats the result sentence (build.ts words it for the public view), so what follows it names no one but the keeper and the spot.
  const lastRow = rows.at(-1)!
  const dive = lastRow.dive === 2 ? 'the keeper stayed' : `the keeper dived ${DIVE_LABEL[lastRow.dive]!.toLowerCase()}`
  const result = lastRow.outcome === 'goal' ? 'Goal' : lastRow.outcome === 'saved' ? 'Saved' : lastRow.outcome === 'over' ? 'Over the bar' : 'Wide'
  moments.push({ kind: 'end', label: `Kick ${lastRow.n}`, tag: 'full time', text: `${sentence} The last kick went ${spot(lastRow.zone)} and ${dive}: ${result}.` })

  return {
    moments,
    view,
    yourKicks: mine.length,
    note: 'A shootout is five kicks each, so a count here is a handful of kicks, not a measure of skill. Whether a kick went in is partly the roll: a good pick improves the odds, it does not decide the kick.',
  }
}
