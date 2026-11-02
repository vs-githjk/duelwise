import { expect, test } from 'bun:test'
import { axisMax, learnCopy, pointsFor } from './learn-copy'

test('a game that does not learn says self-play and test bots, never that every match trains', () => {
  const c = learnCopy({ game: 'word', learns: false, champion: null, sinceCount: 9, sinceEligible: 0 })
  expect(c.body).toBe('Word Duel trains by self-play and against test bots, not from your matches yet. Your match is recorded for your report and the board.')
  expect(c.body).not.toMatch(/every match/i)
})
test('Stormglass is a scripted solver: it never claims self-play or training', () => {
  const c = learnCopy({ game: 'fleet', learns: false, champion: null, sinceCount: 4, sinceEligible: 0 })
  expect(`${c.title} ${c.body}`).not.toMatch(/self-play|trains/i)
  expect(c.body).toContain('scripted solver')
  expect(c.body).toContain('Your match is recorded for your report and the board.')
})
test('a learning game reports what the newest version used and beat, from the gate', () => {
  const c = learnCopy({ game: 'four', learns: true, champion: { version: 'v2', parent: 'v1', humanMatchesUsed: 1800, gate: { score: 0.61125, n: 400, ci95: [0.562637, 0.657747] } }, sinceCount: 2140, sinceEligible: 1900 })
  expect(c.title).toBe('This game learns from your matches.')
  expect(c.body).toBe('v2 trained on self-play plus 1,800 finished human matches, then beat v1 0.61 over 400 games (likely range 0.56 to 0.66). 2,140 finished matches since v2 shipped; 1,900 are eligible for the next training run (the player allowed training and no check flagged it). Eligible is not the same as used: a run picks from the eligible ones.')
})
test('zero human matches is said as zero, and a first version has no retrain claim', () => {
  const c = learnCopy({ game: 'four', learns: true, champion: { version: 'v2', parent: 'v1', humanMatchesUsed: 0, gate: null }, sinceCount: 1, sinceEligible: 0 })
  expect(c.body).toContain('has not used human matches yet')
  expect(c.body).toContain('1 finished match since v2 shipped; 0 are eligible')
  expect(learnCopy({ game: 'four', learns: true, champion: { version: 'v1', parent: null, humanMatchesUsed: 0, gate: null }, sinceCount: 0, sinceEligible: 0 }).body).toContain('No retrained version has shipped yet')
})
test('points are thin under 30 matches, gaps are null, the axis grows in steps of 15', () => {
  const pts = pointsFor([{ start: 'a', levels: { medium: { games: 40, wins: 20 } } }, { start: 'b', levels: { medium: { games: 5, wins: 5 } } }, { start: 'c', levels: {} }], 'medium')
  expect(pts.map((p) => [p.rate, p.thin])).toEqual([[0.5, false], [1, true], [null, true]])
  expect(axisMax(pts)).toBe(100)
  expect(axisMax(pts.slice(0, 1))).toBe(60)
  expect(axisMax([])).toBe(30)
})
