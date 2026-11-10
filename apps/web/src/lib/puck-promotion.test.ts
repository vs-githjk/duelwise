import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { replay } from '@duelwise/core/src/replay'
import { getCore } from '@duelwise/core/src/games/index'
import { encodePuckInput } from '@duelwise/core/src/games/puck/input'
import { makeRng } from '@duelwise/core/src/rng'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { parseRegistry } from '@duelwise/agents/src/registry'
import { createGameAgent } from '@duelwise/agents/src/agent-dispatch'
import { levelInfoFromRegistry } from './level-info'
import { verifiedStrength } from './strength-gates'
import { tileNote } from './tile-copy'
import { buildCast } from '../personas/cast'
import { summariseRegistry } from '../server/stats'

// Glasscut (id puck) is promoted on the branch; a level reads In training until P11's measurement publishes it, and strength appears only for a level the
// registry publishes with a gate the page verifies (P11 writes the registry through the measure script, so this file follows whatever it wrote).
const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']
const reg = parseRegistry(JSON.parse(readFileSync(join(import.meta.dir, '../../../../packages/agents/registry/puck.json'), 'utf8')))

describe('Glasscut is a product game and its record replays', () => {
  test('it is a realtime game open on every device', () => {
    expect(PRODUCT.games.puck).toMatchObject({ displayName: 'Glasscut', slug: 'glasscut', kind: 'realtime', devices: 'all' })
    expect(getCore('puck').id).toBe('puck')
  })

  test('replay() runs a real puck record to its end and agrees with the core', () => {
    const core = getCore('puck')
    const rng = makeRng(77)
    let s = core.init(5, undefined, { level: 'easy' })
    const held: [number | null, number | null] = [null, null]
    const actions: MatchRecordV1['actions'] = []
    for (let tick = 0; !core.terminal(s); tick++) {
      if (tick % 12 === 0) {
        for (const seat of [0, 1] as const) {
          const code = encodePuckInput({ tx: rng.int(1024), ty: rng.int(1024) })
          actions.push([tick, seat, code])
          held[seat] = code
        }
      }
      s = core.step(s, [core.decodeAction(held[0]!), core.decodeAction(held[1]!)])
    }
    const rec: MatchRecordV1 = {
      schema: 1, matchId: 't-puck-5', game: 'puck', coreVersion: core.version, agent: { version: 'v1', level: 'easy' }, seed: 5, humanSeat: 0, actions,
      result: core.result(s)!, finalHash: core.hash(s), startedAt: '2026-11-10T10:00:00.000Z', endedAt: '2026-11-10T10:06:00.000Z', device: 'desktop', input: 'mouse', trainingAllowed: false,
    }
    const out = replay(rec)
    expect(out.ok).toBe(true)
    expect(replay({ ...rec, finalHash: 'f'.repeat(rec.finalHash.length) }).ok).toBe(false)
  })
})

const published = (level: Level) => Boolean(reg.measured[level])

describe('every Glasscut level shows In training until P11 measures it', () => {
  test('the registry is valid, learns nothing from people, and every measured level is one the page verifies', () => {
    expect(reg.game).toBe('puck')
    expect(reg.learnsFromHumans).toBe(false)
    expect(reg.versions.every((v) => v.humanMatchesUsed === 0)).toBe(true)
    for (const level of Object.keys(reg.measured) as Level[]) expect(verifiedStrength(reg, level)).toBe(true)
  })

  test('levels, tile note, cast and strength gate give no strength and no number', () => {
    const info = levelInfoFromRegistry(reg)
    for (const level of LEVELS) {
      expect(info[level].preview).toBe(!published(level))
      if (!published(level)) expect(info[level].strength).toBeUndefined()
      expect(verifiedStrength(reg, level)).toBe(published(level))
    }
    const note = tileNote('puck', summariseRegistry(reg))
    if (LEVELS.every((l) => !published(l))) {
      expect(note).toContain('Every level is in training for now.')
      expect(note).not.toMatch(/Elo|reacts in/)
    }
    const row = buildCast({ puck: reg }).find((r) => r.game === 'puck')!
    for (const level of LEVELS) if (!published(level)) expect(row.cells[level].state).toBe('in-training')
  })

  test('even a registry that claims a measured level and a gate does not verify until a Glasscut gate is written (P11)', () => {
    const fake = JSON.parse(JSON.stringify(reg))
    delete fake.measured.easy
    delete fake.unpublished.easy
    fake.levels.easy = { version: 'v1', config: {} }
    fake.measured.easy = { metric: 'score', value: 0.9, ci95: [0.8, 0.95], n: 400, opponents: 'x', siteElo: 1000, measuredAt: '2026-11-10T09:00:00.000Z', harness: 'bun', commit: 'abc' }
    fake.versions[0].gate = { baseline: { bySeat: [{ seat: 0, games: 400, wins: 399, draws: 0, losses: 1 }, { seat: 1, games: 400, wins: 399, draws: 0, losses: 1 }] }, pairs: [] }
    expect(verifiedStrength(parseRegistry(fake), 'easy')).toBe(false)
  })

  test('the opponent is a preview agent until P11 publishes its level, and it rejects a malformed observation', async () => {
    const agent = await createGameAgent('puck', 'easy')
    expect(agent.preview).toBe(!published('easy'))
    agent.reset(1)
    await expect(agent.act(null, { frame: 0 })).rejects.toThrow()
    agent.dispose()
  })
})
