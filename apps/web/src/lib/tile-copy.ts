import { PRODUCT, gameCountWord, type GameId, type Level } from '@duelwise/core/src/product'
import { personaFor } from '../personas'
import type { RegistrySummary } from '../server/stats'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** What each game is, in one plain sentence. Facts that come from a registry are added by `tileNote`. */
const BASE: Record<GameId, string> = {
  chess: 'Chess against four levels.',
  four: 'Drop discs and line up four in a row.',
  holdem: 'Heads-up poker with play chips. Nothing to buy.',
  word: 'Same hidden word, six guesses each.',
  fighter: '2.5D fighter, best of 3.',
  arena: 'First-person 1v1 shooter, first to 7 rounds.',
  fleet: 'Hidden fleets, ten by ten. Find theirs first.',
  slack: 'Close a line of their discs between two of yours and it flips.',
  penalty: 'Five penalties each. Pick a corner, or dive the right way.',
  puck: 'Air hockey. First to 7 goals, or the lead at six minutes.',
}

/** The noun the tile counts this week's matches in. */
export const MATCH_NOUN: Record<GameId, string> = { chess: 'games', four: 'games', holdem: 'matches', word: 'duels', fighter: 'fights', arena: 'matches', fleet: 'matches', slack: 'games', penalty: 'shootouts', puck: 'matches' }

const named = (level: Level) => personaFor(level).name
const SIM_HZ = 60

/**
 * The tile's one line: the game in a sentence, plus one real fact from its registry when there is one
 * (Word Duel's measured average, a fighter's reaction time, the strongest measured site Elo). Nothing is invented.
 */
export function tileNote(game: GameId, reg: RegistrySummary): string {
  const base = BASE[game]
  const measured = reg.levels.filter((l) => l.state === 'measured')
  if (game === 'word') {
    const m = reg.levels.find((l) => l.level === 'medium' && l.state === 'measured' && typeof l.value === 'number')
    return m?.value !== undefined ? `${base} ${named('medium')} averages ${m.value.toFixed(1)}.` : base
  }
  if (game === 'fighter') {
    const hard = reg.levels.find((l) => l.level === 'hard')
    return hard?.state === 'measured' && hard.reactionFrames ? `${base} ${named('hard')} reacts in ${Math.round((hard.reactionFrames * 1000) / SIM_HZ)} ms.` : base
  }
  if (game === 'arena') return base
  const top = [...measured].reverse().find((l) => typeof l.siteElo === 'number')
  if (!top) return `${base} Every level is in training for now.`
  const practice = reg.levels.filter((l) => l.state !== 'measured').map((l) => named(l.level))
  const tail = practice.length > 0 ? ` ${practice.join(' and ')} ${practice.length === 1 ? 'is' : 'are'} in training.` : ''
  return `${base} ${named(top.level)} site Elo ${Math.round(top.siteElo!)}.${tail}`
}

/** Lowercase count word for the copy; digits below six, where gameCountWord has no word. */
const countWord = (n: number) => (n >= 6 && n <= 12 ? gameCountWord(n).toLowerCase() : String(n))

export interface LearningFacts {
  game: GameId
  learnsFromHumans: boolean
  version: string | null
  promotedAt: string | null
  parent: string | null
  humanMatchesUsed: number
}

/**
 * The third stat on the landing strip, from the same flags the honesty rule reads. A game that learns from people says how many
 * human matches its newest retrain used (zero is said as zero); the others are said not to learn from matches yet (some train by self-play, Word Duel and Stormglass are scripted solvers).
 */
export function learningStrip(facts: LearningFacts[]): { headline: string; body: string } {
  const learners = facts.filter((f) => f.learnsFromHumans)
  const others = facts.length - learners.length
  if (learners.length === 0) return { headline: 'Self-play', body: `None of the ${facts.length} games learn from your matches yet.` }
  const f = learners[0]!
  const name = PRODUCT.games[f.game].displayName
  const when = f.promotedAt ? new Date(f.promotedAt) : null
  const day = when && !Number.isNaN(when.getTime()) ? `${MONTHS[when.getUTCMonth()]} ${when.getUTCDate()}` : null
  const tail = others > 0 ? ` The other ${countWord(others)} do not learn from your matches yet.` : ''
  const retrained = f.parent && day ? `retrained ${day}` : null
  if (retrained && f.humanMatchesUsed > 0) return { headline: `${name} ${f.version}`, body: `${retrained} from ${f.humanMatchesUsed.toLocaleString('en-US')} human matches.${tail}` }
  if (retrained) return { headline: `${name} ${f.version}`, body: `${retrained} on self-play; it has not used human matches yet.${tail}` }
  return { headline: name, body: `learns from finished matches; no retrain has used them yet.${tail}` }
}
