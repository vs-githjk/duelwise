import type { WordObs } from '@duelwise/core/src/games/word/core'
import { ANSWERS, allowedIndex } from '@duelwise/core/src/games/word/lists'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { candidates, chooseGuess } from '../word/solver'

// A6: the Word Duel agent under test in a people measurement: the shipped solver, plus an optional override from WORD_PEOPLE_OVERRIDE
// (JSON: { "<level>": { "slip": 0.3 } }). `slip` is a proposed setting, not a shipped one: that share of guesses is a random word that fits the clues
// instead of the level's own choice, so a strong solver can be given a person's mistakes. Unset, it plays exactly the shipped level.
export const OVERRIDE_ENV = 'WORD_PEOPLE_OVERRIDE'
export interface WordOverride { slip?: number }

export function overrideFor(level: Level, raw: string | undefined = process.env[OVERRIDE_ENV]): WordOverride | undefined {
  if (!raw) return undefined
  return (JSON.parse(raw) as Record<string, WordOverride>)[level]
}

export function guessFor(level: Level, obs: WordObs, rng: Rng, over: WordOverride | undefined): number {
  if (over?.slip && obs.guesses.length > 0 && rng.float() < over.slip) {
    const cands = candidates(obs)
    return allowedIndex(ANSWERS[cands[rng.int(cands.length)]!]!)
  }
  return chooseGuess(level, obs, rng)
}

/** Same seeding as the shipped agent (word/agent.ts), so with no override the games are identical. */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const seat = opts.seat ?? 1
  const over = overrideFor(level)
  let rng: Rng = makeRng(0)
  return {
    preview: false,
    reset(seed) {
      rng = makeRng((seed ^ Math.imul(seat + 1, 0x9e3779b1)) | 0)
    },
    async act(obs) {
      return [guessFor(level, obs as WordObs, rng, over)]
    },
    dispose() {},
  }
}
