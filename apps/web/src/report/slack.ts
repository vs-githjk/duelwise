import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { CELLS, PASS, SIZE, flipsFor, slackCore, type SlackState } from '@duelwise/core/src/games/slack/core'
import type { Moment, Series, SlackView } from './types'
import { walk } from './walk'

// Crosscurrent report. Built only from the stored record: every placement is replayed through the core, so each number below
// (flips, corners, passes, the disc lead after each move) comes from the board, never from a guess about who played well.

const CORNER_CELLS = [0, SIZE - 1, CELLS - SIZE, CELLS - 1] as const
const cellName = (cell: number): string => `${'ABCDEFGH'[cell % SIZE]}${Math.floor(cell / SIZE) + 1}`

/** A turn must flip at least this many discs to be named as the side's biggest. */
export const BIG_TURN = 3

interface Placement {
  /** 1-based count of discs placed so far, by either side (passes are not placements). */
  n: number
  mine: boolean
  cell: number
  flips: number
  /** Disc lead for the player (player's discs minus the AI's) after this placement. */
  lead: number
}

export interface SlackReport {
  moments: Moment[]
  series: Series | null
  view: SlackView | null
  note: string | null
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function slackReport(rec: MatchRecordV1, sentence: string, opponent: string): SlackReport {
  const steps = walk<SlackState, number>(rec)
  // A resigned or unfinished record ends on a board nobody finished: the result alone, never counts of an unfinished game.
  const finished = steps.length > 0 && slackCore.terminal(steps.at(-1)!.after)
  if (!finished) return { moments: [{ kind: 'end', label: 'Result', tag: 'how it ended', text: sentence }], series: null, view: null, note: null }
  const me = rec.humanSeat
  const mineValue = (me + 1) as 1 | 2
  const theirValue = (2 - me) as 1 | 2
  const placements: Placement[] = []
  const passes: [number, number] = [0, 0]
  const corners: SlackView['corners'] = [null, null, null, null]
  for (const st of steps) {
    const { seat, action } = st.moves[0]!
    if (action === PASS) {
      passes[seat === me ? 0 : 1]++
      continue
    }
    const flips = flipsFor(st.before.cells, (seat + 1) as 1 | 2, action).length
    const mine = st.after.cells.filter((v) => v === mineValue).length
    const theirs = st.after.cells.filter((v) => v === theirValue).length
    placements.push({ n: placements.length + 1, mine: seat === me, cell: action, flips, lead: mine - theirs })
    const k = CORNER_CELLS.indexOf(action as (typeof CORNER_CELLS)[number])
    if (k >= 0) corners[k] = seat === me ? 'player' : 'ai'
  }
  const last = steps.at(-1)?.after.cells ?? []
  const cells = Array.from({ length: CELLS }, (_, i) => {
    const v = last[i] ?? 0
    return (v === 0 ? 0 : v === mineValue ? 1 : 2) as 0 | 1 | 2
  })
  const discs: [number, number] = [cells.filter((c) => c === 1).length, cells.filter((c) => c === 2).length]
  const view: SlackView = { cells, discs, corners }

  const moments: Moment[] = []
  const youCorners = corners.filter((c) => c === 'player').length
  const theyCorners = corners.filter((c) => c === 'ai').length
  const empty = corners.filter((c) => c === null).length
  if (youCorners + theyCorners > 0) {
    const tail = empty > 0 ? ` ${plural(empty, 'corner stayed', 'corners stayed')} empty.` : ''
    moments.push({
      kind: youCorners >= theyCorners ? 'best' : 'info',
      label: 'Corners',
      tag: 'discs that can never flip',
      text: `You took ${plural(youCorners, 'corner', 'corners')}; ${opponent} took ${theyCorners}.${tail}`,
      publicText: `The player took ${plural(youCorners, 'corner', 'corners')}; ${opponent} took ${theyCorners}.${tail}`,
      value: `${youCorners} to ${theyCorners}`,
      valueLabel: 'corners',
    })
  }

  const biggest = (mine: boolean): Placement | null => {
    let top: Placement | null = null
    for (const p of placements) if (p.mine === mine && p.flips >= BIG_TURN && (!top || p.flips > top.flips)) top = p
    return top
  }
  const numbered: Array<{ n: number; m: Moment }> = []
  const bestMine = biggest(true)
  const bestTheirs = biggest(false)
  if (bestMine) {
    numbered.push({ n: bestMine.n, m: {
      kind: 'best',
      label: `Placement ${bestMine.n}: ${cellName(bestMine.cell)}`,
      tag: 'biggest turn',
      text: `Placing at ${cellName(bestMine.cell)} flipped ${bestMine.flips} of ${opponent}'s discs at once.`,
      publicText: `The player's placement at ${cellName(bestMine.cell)} flipped ${bestMine.flips} of ${opponent}'s discs at once.`,
      value: `+${bestMine.flips}`,
      valueLabel: 'flips',
    } })
  }
  if (bestTheirs) {
    numbered.push({ n: bestTheirs.n, m: {
      kind: 'turning',
      label: `Placement ${bestTheirs.n}: ${cellName(bestTheirs.cell)}`,
      tag: `${opponent}'s biggest turn`,
      text: `${opponent} flipped ${bestTheirs.flips} of your discs by placing at ${cellName(bestTheirs.cell)}.`,
      publicText: `${opponent} flipped ${bestTheirs.flips} of the player's discs by placing at ${cellName(bestTheirs.cell)}.`,
      value: `+${bestTheirs.flips}`,
      valueLabel: 'flips',
    } })
  }

  // Where the disc lead last changed hands: the last placement after which the lead was not where the game ended (a tie counts as not ahead yet).
  const finalSign = Math.sign(discs[0] - discs[1])
  let lastChange: Placement | null = null
  if (finalSign !== 0) {
    for (let i = placements.length - 1; i >= 0; i--) {
      if (Math.sign(placements[i]!.lead) !== finalSign) {
        lastChange = placements[i + 1] ?? null
        break
      }
    }
  }
  if (lastChange) {
    const ahead = finalSign > 0
    numbered.push({ n: lastChange.n, m: {
      kind: 'turning',
      label: `Placement ${lastChange.n}`,
      tag: 'the lead changed for good',
      text: ahead
        ? `After ${cellName(lastChange.cell)} you went ahead on discs and stayed there to the end.`
        : `After ${cellName(lastChange.cell)} ${opponent} went ahead on discs and stayed there to the end.`,
      publicText: ahead
        ? `After ${cellName(lastChange.cell)} the player went ahead on discs and stayed there to the end.`
        : `After ${cellName(lastChange.cell)} ${opponent} went ahead on discs and stayed there to the end.`,
    } })
  }
  // The named turns read in the order they happened.
  moments.push(...numbered.sort((a, b) => a.n - b.n).map((x) => x.m))

  if (passes[0] + passes[1] > 0) {
    moments.push({
      kind: 'info',
      label: 'Passes',
      tag: 'no legal placement',
      text: `You passed ${passes[0]} ${passes[0] === 1 ? 'time' : 'times'}; ${opponent} passed ${passes[1]}.`,
      publicText: `The player passed ${passes[0]} ${passes[0] === 1 ? 'time' : 'times'}; ${opponent} passed ${passes[1]}.`,
    })
  }
  moments.push({ kind: 'end', label: `Placement ${placements.length}`, tag: 'last disc', text: sentence })

  // The chart: the disc lead after every placement, up is better for the player. Marks sit on the named turns only.
  const marks: Series['marks'] = []
  const at = (p: Placement) => p.n - 1
  if (bestMine) marks.push({ at: at(bestMine), label: `${cellName(bestMine.cell)} +${bestMine.flips}`, kind: 'best' })
  if (bestTheirs) marks.push({ at: at(bestTheirs), label: `${cellName(bestTheirs.cell)} +${bestTheirs.flips}`, kind: 'worst' })
  if (lastChange && !marks.some((m) => m.at === at(lastChange))) marks.push({ at: at(lastChange), label: 'Lead changes', kind: 'turning' })
  const series: Series | null =
    placements.length >= 2
      ? {
          label: `Discs after each placement, yours minus ${opponent}'s`,
          publicLabel: `Discs after each placement, the player's minus ${opponent}'s`,
          unit: 'discs',
          axis: 'placement',
          points: placements.map((p) => p.lead),
          marks,
        }
      : null

  return {
    moments,
    series,
    view,
    note: 'The chart counts discs only. Until the last moves a side with fewer discs can still be better placed, because corners and edges matter more than the count.',
  }
}
