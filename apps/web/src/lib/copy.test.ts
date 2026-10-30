import { expect, test } from 'bun:test'
import type { Result } from '@duelwise/core/src/types'
import { jobLine, lastMatchesLabel, promotionLine, provisionalNote, resultSentence } from './copy'
import { inTrainingCopy, levelInfoFromRegistry } from './level-info'
import type { Registry } from '@duelwise/agents/src/registry'

const RAW = 'in training: hard does not beat medium: score 0.5500 over 200 games, 95% interval [0.4808, 0.6174]'

test('an unpublished level reads as plain words, never the raw gate string or a doubled prefix', () => {
  expect(inTrainingCopy('hard')).toBe('Hard has not yet proven it beats Medium.')
  expect(inTrainingCopy('champion')).toBe('Champion has not yet proven it beats Hard.')
  expect(inTrainingCopy('easy')).toBe('Easy has not been measured yet.')
  const reg = { levels: {}, measured: {}, unpublished: { hard: RAW } } as unknown as Registry
  const info = levelInfoFromRegistry(reg)
  expect(info.hard.inTraining).toBe('Hard has not yet proven it beats Medium.')
  expect(info.medium.inTraining).toBeUndefined()
  for (const l of Object.values(info)) expect(l.inTraining ?? '').not.toMatch(/\d|interval|in training:/i)
})

test('a champion held back by hard failing its gate never claims it fails to beat hard', () => {
  const CHAMP = 'in training: hard did not pass its gate, so champion was not published'
  expect(inTrainingCopy('champion', CHAMP)).toBe('Champion is waiting until Hard is published.')
  const reg = { levels: {}, measured: {}, unpublished: { champion: CHAMP, hard: RAW } } as unknown as Registry
  const info = levelInfoFromRegistry(reg)
  expect(info.champion.inTraining).toBe('Champion is waiting until Hard is published.')
  expect(info.champion.inTraining).not.toMatch(/has not yet proven it beats Hard/)
  expect(info.hard.inTraining).toBe('Hard has not yet proven it beats Medium.')
  expect(inTrainingCopy('hard', 'something unexpected')).toBe('Hard is still being measured.')
})

test('the promotion line needs a published champion, and says it in plain words', () => {
  const base = { game: 'chess' as const, version: 'v1', measured: 3, promotedAt: '2026-10-22T05:17:30.334Z', parent: null, championPublished: true }
  expect(promotionLine({ ...base, parent: 'v0' })).toBe('Champion v1 promoted Oct 22 after beating the previous version.')
  expect(promotionLine(base)).toBe('Champion v1 promoted Oct 22.')
  expect(promotionLine({ ...base, championPublished: false })).toBeNull()
  expect(promotionLine({ ...base, promotedAt: null })).toBeNull()
  expect(promotionLine({ ...base, version: null })).toBeNull()
  expect(promotionLine(undefined)).toBeNull()
  expect(promotionLine({ ...base, parent: 'v0' })).not.toMatch(/gate|cap|Wilson|games/i)
})

const r = (winner: 0 | 1 | null, reason: string): Result => ({ winner, score: winner === null ? [0.5, 0.5] : winner === 0 ? [1, 0] : [0, 1], reason })

test('result reasons are full sentences with a subject', () => {
  expect(resultSentence(r(1, 'solved first'), 0, 'Duelwise')).toBe('Duelwise solved the word first.')
  expect(resultSentence(r(0, 'solved first'), 0, 'Duelwise')).toBe('You solved the word first.')
  expect(resultSentence(r(null, 'both solved in the same round'), 0, 'Duelwise')).toBe('You and Duelwise both solved the word in the same round.')
  expect(resultSentence(r(null, 'neither solved'), 0, 'Duelwise')).toBe('Neither of you solved the word.')
  expect(resultSentence(r(0, 'checkmate'), 0, 'Duelwise')).toBe('You checkmated Duelwise.')
  expect(resultSentence(r(1, 'checkmate'), 0, 'Duelwise')).toBe('Duelwise checkmated you.')
  expect(resultSentence(r(1, 'resigned'), 0, 'Duelwise')).toBe('You resigned.')
  expect(resultSentence(r(0, 'four in a row'), 0, 'Duelwise')).toBe('You connected four in a row.')
  expect(resultSentence(r(1, 'four in a row'), 0, 'Duelwise')).toBe('Duelwise connected four in a row.')
  expect(resultSentence(r(null, 'board full'), 0, 'Duelwise')).toBe('The board filled up with no winner.')
  expect(resultSentence(r(null, 'threefold repetition'), 0, 'Duelwise')).toBe('The position repeated three times, so the game is a draw.')
  expect(resultSentence(r(null, 'stalemate'), 0, 'Duelwise')).toBe('Stalemate: the player to move had no legal move, so the game is a draw.')
  expect(resultSentence(r(1, 'ahead by 40 chips after 30 hands'), 0, 'Duelwise')).toBe('Duelwise finished 40 chips ahead after 30 hands.')
  expect(resultSentence(r(0, 'conceded'), 0, 'Duelwise')).toBe('Duelwise conceded.')
  expect(resultSentence(r(1, 'something new'), 0, 'Duelwise')).toBe('Something new.')
})

test('a training job shows only running or finished, the time and the steps', () => {
  expect(jobLine({ state: 'RUNNING', steps: 25860 }, 'en-US')).toBe('Training: running, 25,860 steps')
  expect(jobLine({ state: 'RUNNING' }, 'en-US')).toBe('Training: running')
  expect(jobLine({ state: 'DONE', finishedAt: Date.UTC(2026, 9, 22, 18, 5) / 1000, steps: 100 }, 'en-US')).toBe('Training: finished Oct 22, 18:05 UTC, 100 steps')
  expect(jobLine({ state: 'DONE' }, 'en-US')).toBe('Training: finished')
  expect(jobLine({ state: 'QUEUED' }, 'en-US')).toBe('Training: waiting to start')
  for (const s of ['STOPPED', 'TIMEOUT', 'FAILED']) expect(jobLine({ state: s }, 'en-US')).toBe('Training: stopped')
})

test('the recent-matches label is singular for one match', () => {
  expect(lastMatchesLabel(1)).toBe('Of your last match')
  expect(lastMatchesLabel(5)).toBe('Of your last 5 matches')
})

test('provisionalNote does not say a realtime level is unmeasured', () => {
  for (const g of ['fighter', 'arena'] as const) {
    expect(provisionalNote(g)).not.toMatch(/not measured yet/)
    expect(provisionalNote(g)).toContain('test bots')
  }
  for (const g of ['chess', 'four', 'holdem', 'word'] as const) expect(provisionalNote(g)).toBe('provisional, the opponent is Practice')
  expect(provisionalNote(undefined)).toBe('provisional, the opponent is Practice')
})

test('round counts use the singular for one', () => {
  expect(resultSentence({ winner: 0, score: [1, 0], reason: 'rounds' }, 0, 'Tinderbox')).toBe('You won 1 round to 0.')
  expect(resultSentence({ winner: 0, score: [3, 1], reason: 'rounds' }, 0, 'Tinderbox')).toBe('You won 3 rounds to 1.')
  expect(resultSentence({ winner: null, score: [1, 1], reason: 'draw' }, 0, 'Tinderbox')).toBe('A draw, 1 round each.')
  expect(resultSentence({ winner: null, score: [2, 2], reason: 'draw' }, 0, 'Tinderbox')).toBe('A draw, 2 rounds each.')
})
