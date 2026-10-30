import { expect, test } from 'bun:test'
import type { Registry } from '@duelwise/agents/src/registry'
import { PERSONAS } from '../personas'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { notTrainedSentence, learnsNote, opponentLabel, pretrainingSentence, recordTrainingAllowed, recordsTrainable, showsPreviewBadge, siteEloExplainer, trainingNoticeText, visibleJobs } from './honest-copy'

const reg = (game: string, levels: Record<string, Record<string, unknown>>, learns = false) =>
  ({ game, champion: 'v1', versions: [], levels: Object.fromEntries(Object.entries(levels).map(([k, config]) => [k, { version: 'v1', config }])), measured: {}, learnsFromHumans: learns }) as unknown as Registry

test('the opponent is named by persona, never by the product', () => {
  expect(opponentLabel('medium')).toBe('Marlow')
  for (const l of ['easy', 'medium', 'hard', 'champion'] as const) expect(opponentLabel(l)).not.toMatch(/duelwise/i)
})

test('chess pretraining line comes from the Lichess bands in the registry', () => {
  const chess = reg('chess', { easy: { band: 'b1100' }, medium: { band: 'b1500' } })
  expect(pretrainingSentence(chess)).toBe('Easy and Medium learned from Lichess human games (rating bands 1100 and 1500).')
  expect(pretrainingSentence(reg('four', { easy: { depth: 1 } }, true))).toBeNull()
  expect(pretrainingSentence(null)).toBeNull()
  expect(pretrainingSentence(reg('chess', { easy: { band: 'b1100' } }))).toBe('Easy learned from Lichess human games (rating band 1100).')
})

test('a chess level held back as Practice still says it learned from Lichess (its config sits in unpublishedConfig)', () => {
  const held = { game: 'chess', champion: 'v1', versions: [], levels: {}, measured: {}, unpublished: { easy: 'x', medium: 'x' }, unpublishedConfig: { easy: { band: 'b1100' }, medium: { band: 'b1500' } } } as unknown as Registry
  expect(pretrainingSentence(held)).toBe('Easy and Medium learned from Lichess human games (rating bands 1100 and 1500).')
})

test('hold\'em records are not trainable while learnsFromHumans is false, and the notice says so', () => {
  const off = trainingNoticeText('holdem', false, 'legitimate-interest')
  expect(off.trainable).toBe(false)
  expect(off.text).toMatch(/not used to train/i)
  expect(off.text).not.toMatch(/may use it to train/i)
  const on = trainingNoticeText('holdem', true, 'legitimate-interest')
  expect(on.trainable).toBe(true)
  expect(on.text).toMatch(/may use it to train/i)
})

test('every game follows its registry: no learning from humans means not trainable and an honest notice', () => {
  for (const game of ['chess', 'word', 'fighter', 'arena', 'holdem'] as const) {
    const c = trainingNoticeText(game, false, 'legitimate-interest')
    expect(c.trainable).toBe(false)
    expect(c.text).toMatch(/does not learn from human matches yet/i)
    expect(c.text).toMatch(/not used to train/i)
    expect(c.text).not.toMatch(/may use it to train|can learn from the matches/i)
    expect(recordsTrainable(game, { learnsFromHumans: false })).toBe(false)
    expect(recordTrainingAllowed(game, { learnsFromHumans: false })).toBe(false)
  }
  // Four learns: it keeps the opt-out notice under legitimate interest and the opt-in notice under opt-in.
  expect(trainingNoticeText('four', true, 'legitimate-interest').text).toMatch(/may use it to train/i)
  expect(trainingNoticeText('four', true, 'opt-in').text).toMatch(/Tick the box/)
  expect(recordsTrainable('four', { learnsFromHumans: true })).toBe(true)
  // A missing registry cannot promise training.
  expect(recordsTrainable('four', null)).toBe(false)
})

test('the notice names the game in its own words, not Hold\'em for every game', () => {
  expect(trainingNoticeText('chess', false, 'legitimate-interest').text).toMatch(/^The Chess agent/)
  expect(trainingNoticeText('holdem', false, 'legitimate-interest').text).toMatch(/^The Hold'em agent/)
})

test('site Elo is explained in plain words', () => {
  const t = siteEloExplainer()
  expect(t).toMatch(/Easy is pinned at 1000/)
  expect(t).toMatch(/200 points/)
  expect(t).toMatch(/76 in 100|about three games in four/)
  expect(t).toMatch(/not a FIDE or chess\.com rating/)
})

test('training jobs are hidden from anyone but the owner', () => {
  const jobs = [{ name: 'chess-sp', state: 'RUNNING', game: 'chess' as const }]
  expect(visibleJobs(jobs, false)).toBeNull()
  expect(visibleJobs(jobs, true)).toEqual(jobs)
  expect(visibleJobs(null, true)).toBeNull()
})

test('Preview shows only for a preview level that is not in training', () => {
  expect(showsPreviewBadge({ preview: true })).toBe(true)
  expect(showsPreviewBadge({ preview: true, inTraining: 'Hard has not yet proven it beats Medium.' })).toBe(false)
  expect(showsPreviewBadge({ preview: false })).toBe(false)
})

test('persona style lines promise nothing the agents do not run', () => {
  const lines = Object.values(PERSONAS).flatMap((p) => Object.entries(p.style))
  const all = lines.map(([, s]) => s).join(' | ')
  expect(all).not.toMatch(/reads your timing|near-equilibrium|almost never bluffs|self-play champion; it has to beat/i)
  expect(PERSONAS.easy.style.holdem).not.toMatch(/random/i) // Easy is a loose beginner over the table, explore is 0
  expect(PERSONAS.easy.style.chess).not.toMatch(/occasional slip/)
})

test('the agents page note names Lichess pretraining instead of claiming self-play only', () => {
  const n = learnsNote({ learns: false, hasLearned: false, pretraining: 'Easy and Medium learned from Lichess human games (rating bands 1100 and 1500).', selfPlay: true, game: 'chess' })
  expect(n).toMatch(/Lichess human games/)
  expect(n).not.toMatch(/Self-play only/i)
  expect(learnsNote({ learns: false, hasLearned: false, pretraining: null, selfPlay: false, game: 'holdem' })).toMatch(/not used for training/)
  expect(learnsNote({ learns: true, hasLearned: false, pretraining: null, selfPlay: false, game: 'four' })).toMatch(/may be used to train this agent\. No promoted version has learned/)
})

test('the privacy sentence lists every game whose registry has learnsFromHumans false, and none that learns', () => {
  const regs: Partial<Record<GameId, { learnsFromHumans: boolean }>> = {}
  for (const g of Object.keys(PRODUCT.games) as GameId[]) regs[g] = JSON.parse(readFileSync(join(import.meta.dir, `../../../../packages/agents/registry/${g}.json`), 'utf8'))
  const sentence = notTrainedSentence(regs)
  for (const g of Object.keys(PRODUCT.games) as GameId[]) {
    if (regs[g]!.learnsFromHumans) expect(sentence).not.toContain(PRODUCT.games[g].displayName)
    else expect(sentence).toContain(PRODUCT.games[g].displayName)
  }
  expect(sentence).not.toMatch(/[\u2013\u2014]/)
  expect(notTrainedSentence({})).toMatch(/Chess.*Four in a Row.*Tinderbox.*Coldstore/)
})

test('learnsNote keeps "uses matches" and "has learned" apart', () => {
  expect(learnsNote({ learns: true, hasLearned: true, pretraining: null, selfPlay: false, game: 'four' })).toMatch(/A promoted version has learned from them/)
})
