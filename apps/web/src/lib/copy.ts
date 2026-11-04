import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import type { Result, Seat } from '@duelwise/core/src/types'
import type { Level } from '@duelwise/core/src/product'
import { personaFor } from '../personas'
import { LEVEL_LABEL } from './level-info'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface PromotionFacts {
  version: string | null
  promotedAt: string | null
  /** Version the champion replaced, when there was one. */
  parent: string | null
  /** True only when the registry's Champion level is published. */
  championPublished: boolean
}

/** The hero's promotion line in plain words, or null when this game has no published Champion. No gate jargon. */
export function promotionLine(card: PromotionFacts | undefined): string | null {
  if (!card?.version || !card.promotedAt || !card.championPublished) return null
  const d = new Date(card.promotedAt)
  if (Number.isNaN(d.getTime())) return null
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
  return `Champion ${card.version} promoted ${day}${card.parent ? ' after beating the previous version' : ''}.`
}

const sentence = (s: string) => (s ? `${s[0]!.toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}` : '')

/** "1 hand", "2 hands". The core's reason text says "1 hands"; every sentence a player reads goes through this. */
export function handsLabel(n: number): string {
  return `${n} ${n === 1 ? 'hand' : 'hands'}`
}

/** A game's terse result reason as a sentence with a subject. Unknown reasons are only capitalised and ended. */
export function resultSentence(result: Result, humanSeat: Seat, opponent: string, third = false, buyIns = 0): string {
  const reason = result.reason.trim()
  const humanWon = result.winner === humanSeat
  // `third` words the sentence about "the player" for a stranger reading a shared report, not to "you".
  const You = third ? 'The player' : 'You'
  const you = third ? 'the player' : 'you'
  const who = humanWon ? You : opponent
  const chips = /^ahead by (\d+) chips after (\d+) hands$/.exec(reason)
  // A Practice match with buy-backs plays on fresh stacks; the chips are the running total over every one of them, and the line says so.
  const stacks = buyIns > 0 ? `, counting all ${buyIns + 1} stacks` : ''
  if (chips) return `${who} finished ${chips[1]} ${Number(chips[1]) === 1 ? 'chip' : 'chips'} ahead after ${handsLabel(Number(chips[2]))}${stacks}.`
  const level = /^chips level after (\d+) hands$/.exec(reason)
  if (level) return `Chips were level after ${handsLabel(Number(level[1]))}${stacks}.`
  // The core writes a bust from the winner's side ("the other player lost..."); the panel names the seat that lost, from the player's view.
  const bust = /^the other player lost all (\d+) chips in hand (\d+)$/.exec(reason)
  if (bust) {
    const loser = humanWon ? opponent : third ? 'The player' : 'You'
    return `${loser} lost all ${bust[1]} chips in hand ${bust[2]}.`
  }
  switch (reason) {
    case 'rounds': {
      const hi = Math.max(result.score[0], result.score[1])
      const lo = Math.min(result.score[0], result.score[1])
      return `${who} won ${hi} ${hi === 1 ? 'round' : 'rounds'} to ${lo}.`
    }
    case 'draw':
      return `A draw, ${result.score[0]} ${result.score[0] === 1 ? 'round' : 'rounds'} each.`
    case 'solved first':
      return `${who} solved the word first.`
    case 'both solved in the same round':
      return `${You} and ${opponent} both solved the word in the same round.`
    case 'neither solved':
      return third ? 'Neither player solved the word.' : 'Neither of you solved the word.'
    case 'checkmate':
      return humanWon ? `${You} checkmated ${opponent}.` : `${opponent} checkmated ${you}.`
    case 'resigned':
      return humanWon ? `${opponent} resigned.` : `${You} resigned.`
    case 'conceded':
      return humanWon ? `${opponent} conceded.` : `${You} conceded.`
    case 'fleet sunk':
      return humanWon ? `${You} sank all five of ${opponent}'s ships.` : `${opponent} sank ${third ? "the player's" : 'your'} whole fleet.`
    case 'most discs':
      return humanWon ? `${You} finished with more discs than ${opponent}.` : `${opponent} finished with more discs than ${you}.`
    case 'level on discs':
      return 'Both sides finished with the same number of discs, so the game is a draw.'
    case 'more goals': {
      const hi = Math.max(result.score[0], result.score[1])
      const lo = Math.min(result.score[0], result.score[1])
      return `${who} won the shootout ${hi} to ${lo}.`
    }
    case 'level after sudden death':
      return 'The shootout was still level after sudden death, so it is a draw.'
    case 'four in a row':
      return `${who} connected four in a row.`
    case 'board full':
      return 'The board filled up with no winner.'
    case 'threefold repetition':
      return 'The position repeated three times, so the game is a draw.'
    case 'stalemate':
      return 'Stalemate: the player to move had no legal move, so the game is a draw.'
    case 'insufficient material':
      return 'Neither side has enough pieces left to checkmate, so the game is a draw.'
    case 'fifty-move rule':
      return 'Fifty moves passed with no capture or pawn move, so the game is a draw.'
    default:
      return sentence(reason)
  }
}

export interface JobFacts {
  state: string
  /** Seconds since the epoch. */
  finishedAt?: number
  steps?: number
}

/** The only thing a public page says about a training job: running or finished (with the time) plus steps. */
export function jobLine(job: JobFacts, locale?: string): string {
  const steps = job.steps !== undefined ? `, ${job.steps.toLocaleString(locale ?? 'en-US')} steps` : ''
  if (job.state === 'RUNNING') return `Training: running${steps}`
  if (job.state === 'QUEUED') return 'Training: waiting to start'
  if (job.state === 'DONE') {
    if (job.finishedAt === undefined) return `Training: finished${steps}`
    const d = new Date(job.finishedAt * 1000)
    const hh = String(d.getUTCHours()).padStart(2, '0')
    const mm = String(d.getUTCMinutes()).padStart(2, '0')
    return `Training: finished ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm} UTC${steps}`
  }
  return 'Training: stopped'
}

/** "Of your last match" or "Of your last 5 matches", never "last 1 matches". */
export function lastMatchesLabel(count: number): string {
  return count === 1 ? 'Of your last match' : `Of your last ${count} matches`
}

/**
 * Why a rating is provisional. Turn games stand in a level the registry has not measured; realtime levels
 * (Tinderbox, Coldstore) are measured against test bots and never get a site Elo, so saying "not measured"
 * would contradict the published strength line.
 */
export function provisionalNote(game: GameId | null | undefined): string {
  if (game && PRODUCT.games[game]?.kind === 'realtime') return 'provisional: this level is measured against test bots, not on the rating scale'
  return 'provisional, the opponent is in training'
}

/** "last match" or "last 5 matches", never "last 1 matches". */
export function matchesWindow(count: number): string {
  return count === 1 ? 'last match' : `last ${count} matches`
}

/** One row of the landing page's latest results. Opponents are named by persona, with the level in brackets. */
export function feedLine(r: { game: GameId; level: Level; outcome: 'human' | 'ai' | 'draw' }): string {
  const game = PRODUCT.games[r.game].displayName
  const p = personaFor(r.level).name
  if (r.outcome === 'human') return `A player beat ${p} (${LEVEL_LABEL[r.level]}) at ${game}`
  if (r.outcome === 'ai') return `${p} beat a player at ${game}`
  return `A player drew ${p} (${LEVEL_LABEL[r.level]}) at ${game}`
}
