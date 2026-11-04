import { expect, test } from 'bun:test'
import type { GameId } from '@duelwise/core/src/product'
import { learningStrip, type LearningFacts } from './tile-copy'

const GAMES: GameId[] = ['four', 'chess', 'holdem', 'word', 'fighter', 'arena', 'fleet', 'slack']
const facts = (): LearningFacts[] =>
  GAMES.map((game) => ({ game, learnsFromHumans: game === 'four', version: game === 'four' ? 'v2' : null, promotedAt: game === 'four' ? '2026-10-22T10:00:00Z' : null, parent: game === 'four' ? 'v1' : null, humanMatchesUsed: 0 }))

test('with eight games the strip spells the count and never says a scripted solver trains by self-play', () => {
  const s = learningStrip(facts())
  expect(s.headline).toBe('Four in a Row v2')
  expect(s.body).toBe('retrained Oct 22 on self-play; it has not used human matches yet. The other seven do not learn from your matches yet.')
})
test('no learner says so for the whole set, without a digit-free claim of self-play', () => {
  const s = learningStrip(facts().map((f) => ({ ...f, learnsFromHumans: false })))
  expect(s.body).toBe('None of the 8 games learn from your matches yet.')
})
