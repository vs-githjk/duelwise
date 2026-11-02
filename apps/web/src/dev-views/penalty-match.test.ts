import { describe, expect, test } from 'bun:test'
import { penaltyCore, type PenaltyState, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent } from '@duelwise/agents/src/penalty/agent'
import {
  AGENT_SEAT,
  HUMAN,
  HOLD_MS,
  MOVE_MS,
  agentChoose,
  lastKickLine,
  outcomeWord,
  pressAction,
  resultLine,
  roleLine,
  scoreSlots,
  startMatch,
  playTick,
  tapZone,
  type PenaltyMatch,
} from './penalty-match'

const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']

async function agentFor(level: Level, seed: number) {
  const a = await createGameAgent(level, { seat: AGENT_SEAT })
  a.reset(seed)
  return a
}

/** Plays a whole match; the player follows `pick(tick)`. Returns the final match. */
async function play(level: Level, seed: number, pick: (tick: number) => Zone): Promise<PenaltyMatch> {
  const agent = await agentFor(level, seed)
  let m = startMatch(seed)
  while (!penaltyCore.terminal(m.state)) m = await playTick(m, agent, () => pick(m.state.kicks.length))
  return m
}

/** A player who alternates in a way that ties often, so sudden death shows up within a few seeds. */
const cycle = (t: number): Zone => ((t * 7 + 1) % 3) as Zone

describe('penalty match logic', () => {
  for (const level of LEVELS) {
    test(`a whole match at ${level} ends with a replayable log and a result`, async () => {
      const m = await play(level, 11, cycle)
      expect(penaltyCore.terminal(m.state)).toBe(true)
      expect(penaltyCore.result(m.state)).not.toBeNull()
      // The log holds one entry per kick, both seats' picks.
      expect(m.log.length).toBe(m.state.kicks.length)
      let s = penaltyCore.init(11)
      for (const pair of m.log) s = penaltyCore.step(s, pair)
      expect(penaltyCore.hash(s)).toBe(penaltyCore.hash(m.state))
    })
  }

  test('sudden death is reached and played to the end at every level', async () => {
    for (const level of LEVELS) {
      let found: PenaltyMatch | null = null
      for (let seed = 1; seed <= 400 && !found; seed++) {
        const m = await play(level, seed, cycle)
        if (m.state.kicks.length > 10) found = m
      }
      expect(found).not.toBeNull()
      const m = found!
      expect(m.state.kicks.length % 2).toBe(0)
      const [a, b] = penaltyCore.result(m.state)!.score!
      expect(a === b).toBe(m.state.kicks.length >= 2 * (5 + 12))
      expect(penaltyCore.observe(m.state, HUMAN).sudden).toBe(true)
      // While it runs, the role line says so.
      const prior: PenaltyState = { seed: m.state.seed, kicks: m.state.kicks.slice(0, 10) }
      expect(roleLine({ ...m, state: prior })).toMatch(/^Sudden death\. (You shoot|You're in goal)\.$/)
    }
  })

  test('the agent action for a tick is fixed before the player commits, whatever the player picks', async () => {
    for (const level of LEVELS) {
      for (const seed of [3, 9, 40]) {
        const seen: Zone[] = []
        for (const pickZone of [0, 1, 2] as Zone[]) {
          const agent = await agentFor(level, seed)
          let m = startMatch(seed)
          const order: string[] = []
          const spy = new Proxy(agent, {
            get(t, k, r) {
              if (k === 'act')
                return async (...args: Parameters<typeof agent.act>) => {
                  order.push('agent')
                  return t.act(...args)
                }
              return Reflect.get(t, k, r)
            },
          })
          m = await playTick(m, spy, () => {
            order.push('player')
            return pickZone
          })
          // The agent is asked first; the player's pick is read afterwards.
          expect(order).toEqual(['agent', 'player'])
          const entry = m.log[0]!
          seen.push(entry[AGENT_SEAT] as Zone)
        }
        expect(new Set(seen).size).toBe(1)
      }
    }
  })

  test('agentChoose reads only the agent seat observation and ignores the human pick', async () => {
    const agent = await agentFor('champion', 5)
    const m = startMatch(5)
    const a = await agentChoose(m, agent)
    const agent2 = await agentFor('champion', 5)
    expect(await agentChoose(m, agent2)).toBe(a)
  })

  test('one tap selects, a second tap on the same zone commits, a different zone moves the selection', () => {
    let r = tapZone(null, 2)
    expect(r).toEqual({ selected: 2, commit: false })
    r = tapZone(r.selected, 0)
    expect(r).toEqual({ selected: 0, commit: false })
    r = tapZone(r.selected, 0)
    expect(r).toEqual({ selected: 0, commit: true })
  })

  test('the action button commits only when a zone is chosen', () => {
    expect(pressAction(null)).toBe(false)
    expect(pressAction(1)).toBe(true)
  })

  test('selecting and slipping change nothing in the match until commit', async () => {
    const m = startMatch(8)
    const before = JSON.stringify(m)
    tapZone(null, 1)
    tapZone(1, 2)
    pressAction(null)
    expect(JSON.stringify(m)).toBe(before)
    expect(m.state.kicks.length).toBe(0)
    expect(m.log.length).toBe(0)
  })

  test('playTick refuses once the shootout is over', async () => {
    const m = await play('easy', 2, cycle)
    const agent = await agentFor('easy', 2)
    await expect(playTick(m, agent, () => 0)).rejects.toThrow()
  })

  test('copy: role line, outcome word, last kick, result', async () => {
    const m0 = startMatch(1)
    expect(roleLine(m0)).toBe('You shoot.')
    const agent = await agentFor('easy', 1)
    let m = await playTick(m0, agent, () => 0)
    expect(roleLine(m)).toBe("You're in goal.")
    expect(lastKickLine(m0, 'Pip')).toBe('')
    const k = m.state.kicks[0]!
    expect(lastKickLine(m, 'Pip')).toMatch(/^You went left\. Pip dived (left|middle|right)\. (Goal|Saved|Wide)\.$/)
    expect(outcomeWord(k)).toBe(k.goal ? 'Goal' : k.zone === k.dive ? 'Saved' : 'Wide')
    m = await playTick(m, agent, () => 1)
    expect(lastKickLine(m, 'Pip')).toMatch(/^Pip went (left|middle|right)\. You dived middle\. (Goal|Saved|Wide)\.$/)
    const over = await play('easy', 2, cycle)
    expect(resultLine(over, 'Pip')).toMatch(/^You \d+, Pip \d+$/)
  })

  test('score slots: goal, miss and not taken, and the rows slide in sudden death', async () => {
    const m0 = startMatch(1)
    expect(scoreSlots(m0, HUMAN)).toEqual(['none', 'none', 'none', 'none', 'none'])
    let found: PenaltyMatch | null = null
    for (let seed = 1; seed <= 400 && !found; seed++) {
      const m = await play('medium', seed, cycle)
      if (m.state.kicks.length > 10) found = m
    }
    const m = found!
    for (const seat of [0, 1] as const) {
      const slots = scoreSlots(m, seat)
      expect(slots.length).toBe(5)
      const mine = m.state.kicks.filter((k) => k.kicker === seat)
      const expected = mine.slice(-5).map((k) => (k.goal ? 'goal' : 'miss'))
      expect(slots).toEqual(expected)
    }
  })

  test('timing constants follow the plan', () => {
    expect(MOVE_MS).toBe(360)
    expect(HOLD_MS).toBe(1100)
  })
})
