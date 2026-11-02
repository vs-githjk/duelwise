import { describe, expect, test } from 'bun:test'
import { penaltyCore, type PenaltyObs, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import { createGameAgent } from './agent'

const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']

/**
 * Plays one match with the agent in `agentSeat`. The other seat's zone at each tick comes from `other(tick)`.
 * The agent is handed only what the production path hands it, core.observe of the finished kicks, before the other
 * seat's pick for that tick exists. Returns the agent's zone per tick and what it was shown.
 */
async function run(level: Level, seed: number, agentSeat: 0 | 1, other: (tick: number) => Zone): Promise<{ acts: Zone[]; seen: string[] }> {
  const agent = await createGameAgent(level, { seat: agentSeat })
  agent.reset(seed)
  let s = penaltyCore.init(seed)
  const acts: Zone[] = []
  const seen: string[] = []
  for (let tick = 0; !penaltyCore.terminal(s); tick++) {
    const o = penaltyCore.observe(s, agentSeat) as PenaltyObs
    seen.push(JSON.stringify(o))
    const [a] = await agent.act(o)
    acts.push(a as Zone)
    const pair: [Zone, Zone] = agentSeat === 0 ? [a as Zone, other(tick)] : [other(tick), a as Zone]
    s = penaltyCore.step(s, pair)
  }
  return { acts, seen }
}

describe('Twelve Yards agents never see the pending choice', () => {
  test('the action at a tick is the same whatever the other seat picks at that tick', async () => {
    let compared = 0
    for (const level of LEVELS) {
      for (const agentSeat of [0, 1] as const) {
        for (let seed = 1; seed <= 12; seed++) {
          const rng = makeRng(seed * 31 + agentSeat)
          const base = Array.from({ length: 40 }, () => rng.int(3) as Zone)
          const ref = await run(level, seed, agentSeat, (t) => base[t]!)
          for (let t = 0; t < ref.acts.length; t++) {
            for (const swap of [1, 2]) {
              // Same history before t, a different pick at t, anything after.
              const alt = await run(level, seed, agentSeat, (k) => (k === t ? (((base[t]! + swap) % 3) as Zone) : k < t ? base[k]! : (((base[k]! + swap) % 3) as Zone)))
              expect(alt.seen[t]).toBe(ref.seen[t])
              expect(alt.acts[t]).toBe(ref.acts[t])
              compared++
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(2000)
  })

  test('the observation handed to an agent has no seed and no roll', async () => {
    for (const level of LEVELS) {
      const bigSeed = 777_123_457
      const { seen } = await run(level, bigSeed, 1, () => 1)
      for (const j of seen) {
        expect(j).not.toContain(String(bigSeed))
        expect(j).not.toContain('seed')
        expect(j).not.toContain('roll')
      }
    }
  })
})
