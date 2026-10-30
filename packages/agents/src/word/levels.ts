import type { Level } from '@duelwise/core/src/product'

/** Easy forgets one earlier marker row this often per guess, so it sometimes plays a word that breaks a clue. */
export const EASY_IGNORE_CHANCE = 0.45

/** The registry `config` of each level; the solver reads these rules, not the values. */
export const WORD_LEVEL_CONFIG: Record<Level, Record<string, unknown>> = {
  easy: { algorithm: 'random-consistent', ignoreOneConstraintChance: EASY_IGNORE_CHANCE },
  medium: { algorithm: 'most-common-consistent', opener: 'seeded-among-6-most-common' },
  hard: { algorithm: 'entropy-over-candidates', guessPool: 'candidates', opener: 'seeded-near-equal-entropy', tieBreak: 'seed' },
  champion: { algorithm: 'entropy-with-two-step-lookahead', guessPool: 'all-allowed', lookaheadTop: 20, opener: 'seeded-near-equal-lookahead', tieBreak: 'seed' },
}
