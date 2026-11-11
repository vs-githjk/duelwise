import { ANSWERS, allowedIndex } from '@duelwise/core/src/games/word/lists'
import type { WordObs } from '@duelwise/core/src/games/word/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { candidates, chooseGuess } from '../word/solver'
import type { Proxy } from './people'
import { PROXY_LEVEL } from './turn-people'

// A6: the Word Duel panel of test players: five-letter word-game players of three kinds, each limited to the common words and each with its own rate of guessing slips.
//   beginner  plays any word that fits the clues but misses one clue 70% of the time; about 4.7 guesses.
//   average   opens from a familiar list, then plays the most common word that fits the clues, 25% of the time a random fitting word; target 4.0 guesses.
//   strong    plays like the Hard solver (the guess that splits the fitting words best), 15% of the time a random fitting word; target about 3.6 guesses.
// Target for the average player: the plan (retune-multiplayer-plan.md line 64) says typical averages for this kind of word game are about 4 guesses. REPORTED, not measured here, no
// source fetched in this task: an assumption the eval file labels. Deterministic per seed.

export const AVERAGE_TARGET = 4.0
export const BEGINNER_MISS_CLUE = 0.7
export const AVERAGE_SLIP = 0.25
export const STRONG_SLIP = 0.15
/** Familiar openers (all common answers); the average player picks one by seed. */
export const AVERAGE_OPENERS: readonly string[] = ['about', 'house', 'stare', 'crane', 'audio', 'raise']

export const PROXY_WORDS: Record<Proxy, string> = {
  beginner: `plays any word that fits the clues, but misses one clue ${Math.round(BEGINNER_MISS_CLUE * 100)}% of the time`,
  average: `opens from six familiar words, then the most common word that fits, ${Math.round(AVERAGE_SLIP * 100)}% of the time a random fitting word (target ${AVERAGE_TARGET} guesses, an assumption)`,
  strong: `plays the guess that splits the fitting words best (the Hard solver), ${Math.round(STRONG_SLIP * 100)}% of the time a random fitting word`,
}

const asAllowed = (answerIdx: number): number => allowedIndex(ANSWERS[answerIdx]!)

/** The ALLOWED index a test player of this kind guesses for an observation. */
export function proxyGuess(proxy: Proxy, obs: WordObs, rng: Rng): number {
  const cands = candidates(obs)
  if (cands.length === 0) throw new Error('word people: no answer fits the feedback')
  const random = (pool: readonly number[]): number => asAllowed(pool[rng.int(pool.length)]!)
  if (proxy === 'beginner') {
    let pool = cands
    if (obs.guesses.length > 0 && rng.float() < BEGINNER_MISS_CLUE) {
      const wider = candidates(obs, rng.int(obs.guesses.length))
      if (wider.length > 0) pool = wider
    }
    return random(pool)
  }
  if (proxy === 'average') {
    if (obs.guesses.length === 0) return allowedIndex(AVERAGE_OPENERS[rng.int(AVERAGE_OPENERS.length)]!)
    return rng.float() < AVERAGE_SLIP ? random(cands) : asAllowed(cands[0]!)
  }
  return rng.float() < STRONG_SLIP ? random(cands) : chooseGuess('hard', obs, rng)
}

export function createProxyAgent(proxy: Proxy, opts: AgentOpts = {}): PreviewAgent {
  const seat = opts.seat ?? 1
  let rng: Rng = makeRng(0)
  return {
    preview: false,
    reset(seed) {
      rng = makeRng((seed ^ Math.imul(seat + 1, 0x9e3779b1) ^ 0x7f4a7c15) | 0)
    },
    async act(obs) {
      return [proxyGuess(proxy, obs as WordObs, rng)]
    },
    dispose() {},
  }
}

const LEVEL_PROXY: Record<string, Proxy> = Object.fromEntries((Object.entries(PROXY_LEVEL) as Array<[Proxy, Level]>).map(([p, l]) => [l, p]))

export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const proxy = LEVEL_PROXY[level]
  if (!proxy) throw new Error(`word people panel: no test player for level ${level}`)
  return createProxyAgent(proxy, opts)
}
