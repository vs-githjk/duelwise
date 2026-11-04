import { expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from '@duelwise/core/src/gzip'
import { ACTION_WIDTH, ALLIN, CALL, infoKey } from '@duelwise/core/src/games/holdem/abstraction'
import { decodeTable } from '@duelwise/core/src/games/holdem/table-format'
import { MATCH_HANDS } from '@duelwise/core/src/games/holdem/match'
import { HOLDEM_LEVELS, handPercentile } from '../holdem/agent'
import { LEVELS } from '../runtime/levels'
import { LADDER_DEALS, SOURCES, botPlayer, duplicateBlock, holdemSeatGate, lbrChunk, levelPlayer, publishedTable, shippedLookup } from './holdem'

const V1 = join(import.meta.dir, '..', '..', '..', '..', 'apps', 'web', 'public', 'agents', 'holdem', 'v1')

test('Holdem strength gates require 400 matches and a passing Wilson bound on each seat', () => {
  expect(holdemSeatGate([Array(200).fill(1), Array(200).fill(1)]).passed).toBe(false)
  expect(holdemSeatGate([Array(400).fill(1), Array(400).fill(1)]).passed).toBe(true)
  expect(holdemSeatGate([Array(400).fill(1), Array(400).fill(-1)]).passed).toBe(false)
  expect(holdemSeatGate([Array(400).fill(1, 0, 300), Array(400).fill(1, 0, 300)]).passed).toBe(false)
})

test('the ladder seat gate wants LADDER_DEALS deals per seat, and a seat just under the bar at 400 deals can clear it at 1000', () => {
  // 0.5487 over 400 deals has a lower bound of 0.4998 (the Oct 30 Champion v Hard seat 1); the same rate over 1000 deals clears 0.5.
  const seat = (n: number, wins: number): number[] => Array.from({ length: n }, (_, i) => (i < wins ? 1 : -1))
  expect(holdemSeatGate([seat(400, 219), seat(400, 219)]).passed).toBe(false)
  expect(holdemSeatGate([seat(1000, 549), seat(1000, 549)], 0.5, LADDER_DEALS).passed).toBe(true)
  expect(holdemSeatGate([seat(400, 260), seat(400, 260)], 0.5, LADDER_DEALS).passed).toBe(false)
  expect(LADDER_DEALS).toBeGreaterThanOrEqual(1000)
})

test('each published table is the snapshot the measurement says, within the size limit', () => {
  for (const level of LEVELS) {
    const path = join(V1, `${level}.bin.gz`)
    expect(statSync(path).size).toBeLessThanOrEqual(15 * 1024 * 1024)
    const table = decodeTable(gunzipSync(new Uint8Array(readFileSync(path)), 256 * 1024 * 1024))
    expect(table.header.iterations).toBe(SOURCES[level].iterations)
    expect(table.header.abstraction.name).toBe(SOURCES[level].abstraction)
  }
})

test('duplicate dealing cancels the cards: a level against itself ties every deal', async () => {
  const a = await levelPlayer('medium')
  const b = await levelPlayer('medium')
  const totals: number[] = []
  const points = await duplicateBlock(a, b, 123_456, totals)(0, 12)
  expect(points).toBe(6)
  expect(totals).toEqual(new Array(12).fill(0))
}, 60_000)

test('duplicate dealing is repeatable and scores a stronger player above a calling station', async () => {
  const run = async () => {
    const totals: number[] = []
    const points = await duplicateBlock(await levelPlayer('champion'), botPlayer('always-call'), 777, totals)(0, 20)
    return { points, totals }
  }
  const first = await run()
  expect(await run()).toEqual(first)
  expect(first.points).toBeGreaterThan(14)
}, 120_000)

test('the strategy a level plays is a distribution over the actions its table allows', () => {
  for (const level of LEVELS) {
    const { table } = publishedTable(level)
    const lookup = shippedLookup(table, level)
    const settings = HOLDEM_LEVELS[level]
    let seen = 0
    for (const key of ['0:20:1:0:1:2', '0:100:1:0:1:2', '0:150:1:0:1:2']) {
      const row = lookup(key)
      if (!row) continue
      seen++
      let sum = 0
      let nonzero = 0
      for (let a = 0; a < ACTION_WIDTH; a++) {
        if (!(row.mask & (1 << a))) expect(row.probs[a]).toBe(0)
        sum += row.probs[a]!
        if (row.probs[a]! > 0) nonzero++
      }
      expect(sum).toBeCloseTo(1, 6)
      if (settings.purify && settings.explore === 0) expect(nonzero).toBe(1)
    }
    expect(lookup('9:9:9:9:9:9')).toBeNull()
    expect(seen).toBe(3)
  }
})

test('local best response is deterministic per match and returns whole matches of hands', () => {
  const a = lbrChunk('easy', 0, 2, 60)
  expect(a.chips.length).toBe(2 * MATCH_HANDS)
  expect(lbrChunk('easy', 0, 2, 60)).toEqual(a)
  const b = lbrChunk('easy', 1, 2, 60)
  expect(b.chips).toEqual(a.chips.slice(MATCH_HANDS))
}, 120_000)

test('the strategy the best responders face follows the level settings: no shove from a weak preflop hand, calls up by the dial', () => {
  const { table } = publishedTable('medium')
  const raw = (key: string) => shippedLookup(table, 'medium', { purify: false, explore: 0 })(key)!
  const shaped = (key: string) => shippedLookup(table, 'medium')(key)!
  let checked = 0
  for (let bucket = 0; bucket < 169 && checked < 5; bucket++) {
    if (handPercentile(0, bucket, 169) >= HOLDEM_LEVELS.medium.shoveFloor) continue
    const key = infoKey({ street: 0, bucket, isButton: true, prior: 0, bet: 1, oppBet: 2 })
    if (!table.maskFor(key)) continue
    checked++
    const r = raw(key)
    const m = shaped(key)
    expect(m.probs[ALLIN]).toBe(0)
    expect(Array.from(m.probs).reduce((a, x) => a + x, 0)).toBeCloseTo(1, 6)
    expect(m.probs[CALL]!).toBeGreaterThanOrEqual(r.probs[CALL]! + 0.5 * (1 - r.probs[CALL]! - r.probs[ALLIN]!) - 1e-6)
  }
  expect(checked).toBeGreaterThan(0)
})

// ---- the published ladder reads right (KA4) ----

test('the published registry: Medium and Hard are 100+ site Elo apart, every step rises, and the mixed Champion is no easier to exploit than Hard', () => {
  const reg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'registry', 'holdem.json'), 'utf8'))
  if (reg.measured.medium && reg.measured.hard) {
    expect(reg.measured.hard.siteElo - reg.measured.medium.siteElo).toBeGreaterThanOrEqual(100)
  }
  for (let index = 1; index < LEVELS.length; index++) {
    const lower = reg.measured[LEVELS[index - 1]!]
    const upper = reg.measured[LEVELS[index]!]
    if (lower && upper) expect(upper.siteElo).toBeGreaterThan(lower.siteElo)
  }
  const gate = reg.versions[0].gate
  expect(gate.settings.champion.purify).toBe(false)
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    if (JSON.stringify(gate.settings[level]) !== JSON.stringify(HOLDEM_LEVELS[level])) {
      expect(reg.unpublished[level]).toContain('settings changed since last measurement')
      expect(reg.measured[level]).toBeUndefined()
    } else {
      expect(reg.measured[level] || reg.unpublished[level]).toBeTruthy()
    }
  }
  for (const l of ['medium', 'hard'] as const) expect(gate.settings[l].shoveFloor).toBeGreaterThan(0)
  const lbr = (l: string): { mbbPerHand: number; ci95: [number, number] } => gate.exploitability.lbrByLevel[l]
  expect(lbr('champion').mbbPerHand).toBeLessThan(lbr('hard').mbbPerHand)
  // Exploitability falls with the level.
  expect(lbr('easy').mbbPerHand).toBeGreaterThan(lbr('medium').mbbPerHand)
  expect(lbr('medium').mbbPerHand).toBeGreaterThan(lbr('hard').mbbPerHand)
})
