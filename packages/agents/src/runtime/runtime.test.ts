import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createCounterGame } from '@duelwise/core/src/testing/counter-game'
import { createAgent } from './agent'
import { loadRegistry, verifySha256 } from './registry-loader'
import { LEVELS, adjacentPairs, isLevel, pairBudget } from './levels'

const FIX = join(import.meta.dir, '../../fixtures')

describe('createAgent over a Web Worker', () => {
  test('round-trips init, reset, act and dispose through the worker protocol', async () => {
    const core = createCounterGame('four')
    const agent = await createAgent('four', 'easy', { seat: 0, factoryModule: join(FIX, 'counter-agent.ts') })
    agent.reset(3)
    const s = core.init(3)
    const out = await agent.act(core.observe(s, 0), s)
    expect(core.legal(s, 0).map(core.encodeAction)).toContain(out[0]!)
    agent.dispose()
    await expect(agent.act(core.observe(s, 0), s)).rejects.toThrow()
  })

  test('surfaces a factory error from the worker', async () => {
    await expect(createAgent('four', 'easy', { factoryModule: join(FIX, 'does-not-exist.ts') })).rejects.toThrow()
  })

  test('with an in-process core option it runs inline (cores cannot be sent to a worker)', async () => {
    const core = createCounterGame('four')
    const agent = await createAgent('four', 'easy', { core, seat: 0, factoryModule: join(FIX, 'counter-agent.ts') })
    agent.reset(1)
    const s = core.init(1)
    expect(core.legal(s, 0).map(core.encodeAction)).toContain((await agent.act(core.observe(s, 0), s))[0]!)
    agent.dispose()
  })
})

describe('levels and registry loader', () => {
  test('levels helpers', () => {
    expect(LEVELS).toEqual(['easy', 'medium', 'hard', 'champion'])
    expect(isLevel('hard')).toBe(true)
    expect(isLevel('expert')).toBe(false)
    expect(adjacentPairs(['easy', 'medium', 'hard'])).toEqual([
      { lower: 'easy', upper: 'medium' },
      { lower: 'medium', upper: 'hard' },
    ])
    expect(() => adjacentPairs(['easy', 'hard'])).toThrow()
    expect(pairBudget('word').maxGames).toBe(400)
  })

  test('loadRegistry returns null when a game has no registry yet, and validates one when present', async () => {
    expect(await loadRegistry('arena', async () => null)).toBeNull()
    await expect(loadRegistry('four', async () => ({ game: 'four' }))).rejects.toThrow()
  })

  test('verifySha256', async () => {
    const bytes = new TextEncoder().encode('abc')
    const ok = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    expect(await verifySha256(bytes, ok)).toBe(true)
    expect(await verifySha256(bytes, '0'.repeat(64))).toBe(false)
  })
})
