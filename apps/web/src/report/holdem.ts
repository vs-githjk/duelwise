import { rank7, handCategory } from '@duelwise/core/src/games/holdem/evaluator'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import type { HandSummary, HoldemState } from '@duelwise/core/src/games/holdem/match'
import { fullHandName } from '../games/holdem/strength'
import { isHumanLoss, nearMiss, NOT_CLOSE, type NearMiss } from './near-miss'
import type { Moment } from './types'
import { walk } from './walk'

/** Every hand that finished in the record, with the chips the player won (negative for a loss). */
export function playedHands(rec: MatchRecordV1): Array<{ hand: HandSummary; human: number }> {
  const out: Array<{ hand: HandSummary; human: number }> = []
  for (const step of walk<HoldemState>(rec)) {
    const done = step.after.last
    // A hand ends when the summary of the last hand changes; a concede ends the match with no new summary.
    if (done && done !== step.before.last && done.hand === step.before.hand) out.push({ hand: done, human: rec.humanSeat === 0 ? done.delta : -done.delta })
  }
  return out
}

const chips = (n: number): string => `${n} ${n === 1 ? 'chip' : 'chips'}`

function sentence(h: HandSummary, human: number, seat: number, opponent: string, third: boolean): string {
  const won = Math.abs(human)
  const you = third ? 'The player' : 'You'
  const your = third ? "the player's" : 'your'
  const who = human > 0 ? you : opponent
  if (h.showdown && h.hole) {
    const winSeat = human > 0 ? seat : 1 - seat
    const loseSeat = 1 - winSeat
    const win = fullHandName(h.hole[winSeat]!, h.board)
    const lose = fullHandName(h.hole[loseSeat]!, h.board).replace(/^a /, '')
    const winScore = rank7([...h.hole[winSeat]!, ...h.board])
    const loseScore = rank7([...h.hole[loseSeat]!, ...h.board])
    const ranks = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace']
    let deciding = ''
    if (win === fullHandName(h.hole[loseSeat]!, h.board) && handCategory(winScore) === handCategory(loseScore)) {
      for (let i = 0; i < 5; i++) {
        const a = (winScore >> (16 - 4 * i)) & 15
        const b = (loseScore >> (16 - 4 * i)) & 15
        if (a !== b) { deciding = `, with ${ranks[a]} against ${ranks[b]} as the deciding kicker`; break }
      }
    }
    return `${who} won ${chips(won)} at showdown with ${win}, against ${human > 0 ? opponent + "'s" : your} ${lose}${deciding}.`
  }
  return human > 0 ? `${you} won ${chips(won)} when ${opponent} folded.` : `${opponent} won ${chips(won)} when ${third ? 'the player' : 'you'} folded.`
}

/**
 * Key moments of a Hold'em match: the hand that won the player the most chips and the hand that cost the most, read from the
 * replayed hands. A match with no won or no lost hand has no such moment, and the closing row is added by the caller.
 */
export function holdemMoments(rec: MatchRecordV1, opponent: string): Moment[] {
  const hands = playedHands(rec)
  let best: (typeof hands)[number] | null = null
  let worst: (typeof hands)[number] | null = null
  for (const h of hands) {
    if (h.human > 0 && (best === null || h.human > best.human)) best = h
    if (h.human < 0 && (worst === null || h.human < worst.human)) worst = h
  }
  const make = (h: (typeof hands)[number], kind: 'best' | 'worst'): { at: number; moment: Moment } => ({
    at: h.hand.hand,
    moment: {
      kind,
      label: `Hand ${h.hand.hand + 1}`,
      tag: kind === 'best' ? 'biggest win' : 'biggest loss',
      text: sentence(h.hand, h.human, rec.humanSeat, opponent, false),
      publicText: sentence(h.hand, h.human, rec.humanSeat, opponent, true),
      value: `${h.human > 0 ? '+' : '-'}${Math.abs(h.human)}`,
      valueLabel: 'chips',
    },
  })
  const picks = [best && make(best, 'best'), worst && make(worst, 'worst')].filter((m): m is { at: number; moment: Moment } => m !== null)
  return picks.sort((a, b) => a.at - b.at).map((p) => p.moment)
}

/** The most chips a close loss can be behind by: five big blinds. */
export const CLOSE_CHIPS = 10

/**
 * Hold'em's near miss: a match played to its last hand and lost by ten chips or fewer. It names the hand that cost the most, worded by the same sentence the
 * key moments use (a showdown names both hands because the table showed them; a fold names no cards), and counts the hands from the replay.
 */
export function holdemNearMiss(rec: MatchRecordV1, opponent: string): NearMiss | null {
  if (!isHumanLoss(rec) || rec.options?.leftAfter !== undefined) return null
  const steps = walk<HoldemState>(rec)
  const end = steps.at(-1)?.after
  if (!end?.over || end.over.reason === 'conceded') return null
  // A match under the strict bust rule that ended on a bust (a whole stack gone in one hand) is the opposite of close.
  if (!end.over.reason.startsWith('ahead by')) return NOT_CLOSE
  const hands = playedHands(rec)
  const gap = -end.net[rec.humanSeat]
  if (gap <= 0) return null
  if (gap > CLOSE_CHIPS) return NOT_CLOSE
  let worst: (typeof hands)[number] | null = null
  for (const h of hands) if (h.human < 0 && (worst === null || h.human < worst.human)) worst = h
  const lost = hands.filter((h) => h.human < 0).length
  const won = hands.filter((h) => h.human > 0).length
  const cost = worst ? Math.abs(worst.human) : 0
  const decisive = worst && cost > gap ? ' That one hand cost more than the whole gap.' : ''
  const turn = (third: boolean): string | null => (worst ? `Hand ${worst.hand.hand + 1}: ${sentence(worst.hand, worst.human, rec.humanSeat, opponent, third)}${decisive}` : null)
  return nearMiss(true, {
    turning: turn(false),
    publicTurning: turn(true),
    line: `You finished ${chips(gap)} behind after ${hands.length} hands.`,
    publicLine: `The player finished ${chips(gap)} behind after ${hands.length} hands.`,
    stats: [
      { label: gap === 1 ? 'Chip short' : 'Chips short', value: gap },
      { label: won === 1 ? 'Hand won' : 'Hands won', value: won },
      { label: lost === 1 ? 'Hand lost' : 'Hands lost', value: lost },
      ...(worst ? [{ label: 'Biggest lost pot', value: cost }] : []),
    ],
  })
}
