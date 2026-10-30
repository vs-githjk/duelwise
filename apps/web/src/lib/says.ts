import type { GameId, Level } from '@duelwise/core/src/product'
import type { Result, Seat } from '@duelwise/core/src/types'
import lines from '../personas/lines.json'
import { LEVELS } from './level-info'
import { personaFor } from '../personas'

/**
 * What the opponent says after a match. A win gets a warm, real compliment; a loss, a close loss or a wrong call gets a cheeky one
 * (never mean, never about the player). A call line wins over a result line. Every line is under 90 characters and is written in lines.json.
 */
export type Situation = 'win' | 'loss' | 'closeLoss' | 'draw' | 'callWrong' | 'callRight'

const UNIT: Record<GameId, string> = { word: 'guess', chess: 'move', four: 'move', fighter: 'round', arena: 'round', holdem: 'hand' }

export interface SaysInput {
  game: GameId
  level: Level
  result: Result
  humanSeat: Seat
  /** The level the player called before the match, when there was one. */
  call: Level | null
  /** How many moves the human played (turn games), for the close-loss rule. */
  humanMoves: number
  /** The opponent's wins and losses against people, when the match store has them. */
  record?: { wins: number; losses: number } | null
}

const lvl = (l: Level) => LEVELS.indexOf(l)

/** A close loss, per game: Word Duel lost late (every guess nearly used), Chess and Four after move 30, Tinderbox and Coldstore by one round, Hold'em by under a big blind per hand. */
export function isCloseLoss(i: Pick<SaysInput, 'game' | 'result' | 'humanSeat' | 'humanMoves'>): boolean {
  const me = i.result.score?.[i.humanSeat]
  const them = i.result.score?.[(1 - i.humanSeat) as Seat]
  switch (i.game) {
    case 'word':
      return i.humanMoves >= 5
    case 'chess':
      return i.humanMoves > 30
    case 'four':
      return i.humanMoves > 15
    case 'fighter':
    case 'arena':
      return typeof me === 'number' && typeof them === 'number' && them - me === 1
    case 'holdem': {
      const m = /^ahead by (\d+) chips after (\d+) hands$/.exec(i.result.reason)
      return m ? Number(m[1]) < Number(m[2]) * 10 : false
    }
  }
}

export function situationOf(i: SaysInput): Situation {
  if (i.result.winner === null) return 'draw'
  const won = i.result.winner === i.humanSeat
  if (won && i.call !== null && lvl(i.level) === lvl(i.call)) return 'callRight'
  if (!won && i.call !== null && lvl(i.level) <= lvl(i.call)) return 'callWrong'
  if (won) return 'win'
  return isCloseLoss(i) ? 'closeLoss' : 'loss'
}

export function sayLine(i: SaysInput): { situation: Situation; text: string } {
  const situation = situationOf(i)
  const set = (lines as Record<string, Record<string, string>>)[i.level]!
  let template = set[situation]!
  if (situation === 'loss' && i.level === 'champion' && i.record && i.record.wins + i.record.losses >= 20 && set.lossRecord) template = set.lossRecord
  const text = template
    .replaceAll('{unit}', UNIT[i.game])
    .replaceAll('{call}', i.call ? personaFor(i.call).name : '')
    .replaceAll('{wins}', String(i.record?.wins ?? 0))
    .replaceAll('{losses}', String(i.record?.losses ?? 0))
  return { situation, text }
}
