import type { GameId, Level } from '@duelwise/core/src/product'
import type { Result, Seat } from '@duelwise/core/src/types'
import { RATED_NOT_OPEN } from '@duelwise/core/src/rated-path'
import { PRODUCT } from '@duelwise/core/src/product'
import lines from '../personas/lines.json'
import { LEVELS } from './level-info'
import { personaFor } from '../personas'

/**
 * What the opponent says after a match. A win gets a warm, real compliment; a loss, a close loss or a wrong call gets a cheeky one
 * (never mean, never about the player). A call line wins over a result line. Every line is under 90 characters and is written in lines.json.
 */
export type Situation = 'win' | 'loss' | 'closeLoss' | 'draw' | 'callWrong' | 'callRight'

const UNIT: Record<GameId, string> = { word: 'guess', chess: 'move', four: 'move', fighter: 'round', arena: 'round', holdem: 'hand', fleet: 'shot', slack: 'move', penalty: 'kick', puck: 'goal' }

export interface SaysInput {
  game: GameId
  level: Level
  result: Result
  humanSeat: Seat
  /** The level the player called before the match, when there was one. */
  call: Level | null
  /** How many moves the human played (turn games), for the close-loss rule. */
  humanMoves: number
  /** Stormglass: the hits the player still needed when the match ended. One means the next shot would have won it. */
  shortBy?: number
  /** The opponent's wins and losses against people, when the match store has them. */
  record?: { wins: number; losses: number } | null
  /**
   * Whether this win may promise progression. 'counted' (the default) is a win the server has counted; 'plain' is one that has not counted
   * (still uploading, rejected, fixed seed, not counted); 'practice' is a practice win. Only the two win lines ever name the next opponent.
   */
  progress?: 'counted' | 'plain' | 'practice'
}

const lvl = (l: Level) => LEVELS.indexOf(l)

/** A close loss, per game: Word Duel lost late (every guess nearly used), Chess and Four after move 30, Tinderbox and Coldstore by one round, Hold'em by under a big blind per hand, Stormglass one shot short of sinking the last ship. */
export function isCloseLoss(i: Pick<SaysInput, 'game' | 'result' | 'humanSeat' | 'humanMoves' | 'shortBy'>): boolean {
  const me = i.result.score?.[i.humanSeat]
  const them = i.result.score?.[(1 - i.humanSeat) as Seat]
  switch (i.game) {
    case 'word':
      return i.humanMoves >= 5
    case 'chess':
      return i.humanMoves > 30
    case 'four':
      return i.humanMoves > 15
    case 'fleet':
      return i.shortBy === 1
    case 'puck':
    case 'penalty':
      // A shootout (or a Glasscut match) lost by one goal is the close one.
      return typeof me === 'number' && typeof them === 'number' && them - me === 1
    case 'slack':
      // The result carries a winner, not a disc count, so a close loss cannot be told from a heavy one.
      return false
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
  // A game with no rated path has nothing to count or open: a win there uses the Plain line (no promise of a next opponent), whatever progress says.
  const noRated = RATED_NOT_OPEN.includes(i.game)
  const progress = noRated ? 'plain' : i.progress
  if ((situation === 'win' || situation === 'callRight') && progress && progress !== 'counted') {
    const suffix = progress === 'practice' ? 'Practice' : 'Plain'
    template = set[`${situation}${suffix}`] ?? template
  }
  if (noRated && (situation === 'win' || situation === 'callRight')) template += ` ${PRODUCT.games[i.game].displayName} matches are Practice for now, so every opponent is open to try.`
  if (situation === 'loss' && i.level === 'champion' && i.record && i.record.wins + i.record.losses >= 20 && set.lossRecord) template = set.lossRecord
  const text = template
    .replaceAll('{unit}', UNIT[i.game])
    .replaceAll('{call}', i.call ? personaFor(i.call).name : '')
    .replaceAll('{wins}', String(i.record?.wins ?? 0))
    .replaceAll('{losses}', String(i.record?.losses ?? 0))
  return { situation, text: i.game === 'penalty' ? penaltyWin(text, situation, i) : text }
}

/**
 * Twelve Yards wins say what the score was and stay honest about what a shootout is: "Clean win" is not true of a one-goal win, and a win over Sable is real but
 * five kicks each are short and partly the roll, so "Frame it" promised more than the score can show. Other games and every other line are as lines.json has them.
 */
export function penaltyWin(text: string, situation: Situation, i: Pick<SaysInput, 'result' | 'humanSeat'>): string {
  if (situation !== 'win' && situation !== 'callRight') return text
  const me = i.result.score?.[i.humanSeat]
  const them = i.result.score?.[(1 - i.humanSeat) as Seat]
  if (typeof me !== 'number' || typeof them !== 'number') return text
  const close = me - them === 1
  return text
    .replace(/^Clean win over (\S+?)\./, (_m, who: string) => `${close ? 'Close win' : 'Win'} over ${who}, ${me} to ${them}.`)
    .replace('That is a real accomplishment. Frame it.', 'A shootout is short and partly the roll, so it is a real win and the next one tells you more.')
}
