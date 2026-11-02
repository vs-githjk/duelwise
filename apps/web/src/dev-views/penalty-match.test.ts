import { describe, expect, test } from 'bun:test'
import { penaltyCore, type Kick, type PenaltyState, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent } from '@duelwise/agents/src/penalty/agent'
import {
  AGENT_SEAT,
  HUMAN,
  CLEAR_MS,
  CONTACT_MS,
  FLIGHT_MS,
  KICK_MS,
  SET_MS,
  SKIP_AFTER_MS,
  SPOT,
  agentChoose,
  aimFromDrag,
  cellCentre,
  diveOf,
  flightOf,
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
const cycle = (t: number): Zone => ((t * 7 + 1) % 5) as Zone

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
        for (const pickZone of [0, 1, 2, 3, 4] as Zone[]) {
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

  test('the agent is shown its own seat observation: the agent seat, the opposite role, nothing of the player', async () => {
    for (const level of LEVELS) {
      const agent = await agentFor(level, 5)
      const seen: unknown[] = []
      const spy = new Proxy(agent, {
        get(t, k, r) {
          if (k === 'act')
            return async (...args: Parameters<typeof agent.act>) => {
              seen.push(args[0])
              return t.act(...args)
            }
          return Reflect.get(t, k, r)
        },
      })
      let m = startMatch(5)
      const expected: unknown[] = []
      for (let tick = 0; tick < 6; tick++) {
        // Tick 0 and after several kicks; the player's role must be the opposite of the one the agent sees.
        expected.push(penaltyCore.observe(m.state, AGENT_SEAT))
        const mine = penaltyCore.observe(m.state, HUMAN)
        const theirs = penaltyCore.observe(m.state, AGENT_SEAT)
        expect(theirs.seat).toBe(AGENT_SEAT)
        expect(theirs.role).not.toBeNull()
        expect(theirs.role).not.toBe(mine.role)
        m = await playTick(m, spy, () => ((tick * 2 + 1) % 5) as Zone)
      }
      expect(seen).toEqual(expected)
      for (const o of seen as Array<{ seat: number }>) expect(o.seat).toBe(AGENT_SEAT)
    }
  })

  test('agentChoose passes the agent seat observation to act, never the human one', async () => {
    const agent = await agentFor('champion', 5)
    let first: unknown
    const spy = new Proxy(agent, {
      get(t, k, r) {
        if (k === 'act')
          return async (...args: Parameters<typeof agent.act>) => {
            first = args[0]
            return t.act(...args)
          }
        return Reflect.get(t, k, r)
      },
    })
    const m = startMatch(5)
    await agentChoose(m, spy)
    expect(first).toEqual(penaltyCore.observe(m.state, AGENT_SEAT))
    expect(first).not.toEqual(penaltyCore.observe(m.state, HUMAN))
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
    expect(lastKickLine(m, 'Pip')).toMatch(/^You went top left\. Pip (dived (left|right) (high|low)|stayed)\. (Goal|Saved|Wide|Over)\.$/)
    m = await playTick(m, agent, () => 1)
    expect(lastKickLine(m, 'Pip')).toMatch(/^Pip went .+\. You dived left low\. (Goal|Saved|Wide|Over)\.$/)
    const over = await play('easy', 2, cycle)
    const [h, a] = penaltyCore.result(over.state)!.score!
    expect(resultLine(over, 'Pip')).toBe(`You ${h}, Pip ${a}`)
  })

  // Hand-built kicks: the words are literal, so a swapped branch or seat cannot hide behind a played match.
  const withKick = (k: Kick): PenaltyMatch => ({ state: { seed: 1, kicks: [k] }, log: [] })
  const goal: Kick = { kicker: HUMAN, zone: 0, dive: 3, goal: true, onTarget: true }
  const saved: Kick = { kicker: AGENT_SEAT, zone: 4, dive: 2, goal: false, onTarget: true }
  const wide: Kick = { kicker: HUMAN, zone: 8, dive: 0, goal: false, onTarget: false }
  const over: Kick = { kicker: HUMAN, zone: 2, dive: 0, goal: false, onTarget: false }
  const overCentre: Kick = { kicker: AGENT_SEAT, zone: 4, dive: 0, goal: false, onTarget: false }
  const goalIntoDive: Kick = { kicker: AGENT_SEAT, zone: 4, dive: 2, goal: true, onTarget: true }

  test('outcome word states the cause: Goal, Saved, Wide, Over, and a goal wins over the keeper picking right', () => {
    expect(outcomeWord(goal)).toBe('Goal')
    expect(outcomeWord(saved)).toBe('Saved')
    expect(outcomeWord(wide)).toBe('Wide')
    expect(outcomeWord(over)).toBe('Over')
    expect(outcomeWord(overCentre)).toBe('Over')
    expect(outcomeWord(goalIntoDive)).toBe('Goal')
  })

  test('last kick line in words for each outcome, each dive word and the centre', () => {
    expect(lastKickLine(withKick(goal), 'Pip')).toBe('You went top left. Pip dived right high. Goal.')
    expect(lastKickLine(withKick(saved), 'Pip')).toBe('Pip went down the middle. You stayed. Saved.')
    expect(lastKickLine(withKick(wide), 'Pip')).toBe('You went bottom right. Pip dived left high. Wide.')
    expect(lastKickLine(withKick(over), 'Pip')).toBe('You went top right. Pip dived left high. Over.')
    expect(lastKickLine(withKick(goalIntoDive), 'Pip')).toBe('Pip went down the middle. You stayed. Goal.')
  })

  test('a drag maps to the cell it points at, a short drag or a pull back is no pick', () => {
    // No thumb movement, a nudge inside the dead zone, and a drag away from the goal: nothing, so lifting cancels.
    expect(aimFromDrag(0, 0, 'shooter')).toBeNull()
    expect(aimFromDrag(8, -12, 'shooter')).toBeNull()
    expect(aimFromDrag(40, 30, 'shooter')).toBeNull()
    // Straight up by rows: bottom, middle, top, and clamped past the bar.
    expect(aimFromDrag(0, -70, 'shooter')).toBe(7)
    expect(aimFromDrag(0, -100, 'shooter')).toBe(4)
    expect(aimFromDrag(0, -130, 'shooter')).toBe(1)
    expect(aimFromDrag(0, -400, 'shooter')).toBe(1)
    // All nine cells can be reached, and a long sideways drag stays on the edge column.
    const reached = new Set<number>()
    for (const dx of [-60, 0, 60]) for (const dy of [-70, -100, -130]) reached.add(aimFromDrag(dx, dy, 'shooter')!)
    expect(reached.size).toBe(9)
    expect(aimFromDrag(-300, -130, 'shooter')).toBe(0)
    expect(aimFromDrag(300, -70, 'shooter')).toBe(8)
    // The keeper's five dives from the same gesture.
    expect(aimFromDrag(-60, -130, 'keeper')).toBe(0)
    expect(aimFromDrag(-60, -70, 'keeper')).toBe(1)
    expect(aimFromDrag(0, -100, 'keeper')).toBe(2)
    expect(aimFromDrag(60, -130, 'keeper')).toBe(3)
    expect(aimFromDrag(60, -70, 'keeper')).toBe(4)
  })

  test('a kick lands where its cause says: in the cell, past a post, over the bar, or short of the line at the keeper', () => {
    const end = (k: Kick) => {
      const f = flightOf(k)
      return { x: SPOT.x + f.bx, y: SPOT.y + f.by }
    }
    for (let zone = 0; zone < 9; zone++) {
      const c = cellCentre(zone)
      const g: Kick = { kicker: HUMAN, zone: zone as Zone, dive: 2, goal: true, onTarget: true }
      expect(end(g)).toEqual(c)
      const s0: Kick = { ...g, goal: false }
      expect(Math.abs(end(s0).x - c.x)).toBeLessThan(1)
      expect(end(s0).y).toBeGreaterThan(c.y)
      const off: Kick = { ...g, goal: false, onTarget: false }
      if (outcomeWord(off) === 'Over') expect(end(off).y).toBeLessThan(16)
      else expect(end(off).x < 24 || end(off).x > 304).toBe(true)
      // No shot flies a straight line, in any column.
      expect(Math.abs(flightOf(g).curl)).toBeGreaterThan(10)
    }
  })

  test('each dive goes its own way, left is left, and a stay stays in the middle', () => {
    const at = (dive: 0 | 1 | 2 | 3 | 4) => diveOf({ kicker: HUMAN, zone: 4, dive, goal: false, onTarget: true })
    expect(at(0).kx).toBeLessThan(0)
    expect(at(1).kx).toBeLessThan(0)
    expect(at(3).kx).toBeGreaterThan(0)
    expect(at(4).kx).toBeGreaterThan(0)
    expect(at(2).kx).toBe(0)
    expect(at(0).ky).toBeLessThan(at(1).ky)
    expect(at(3).ky).toBeLessThan(at(4).ky)
    expect(new Set([0, 1, 2, 3, 4].map((d) => JSON.stringify(at(d as 0))).values()).size).toBe(5)
  })

  test('result line puts the player first and matches the core score on a hand-built 3 to 1', () => {
    // Five rounds, seat 0 kicks first each round: you score 3 of 5, Pip 1 of 5.
    const ys = [true, true, false, true, false]
    const ps = [false, true, false, false, false]
    const kicks: Kick[] = []
    for (let r = 0; r < 5; r++) {
      kicks.push({ kicker: HUMAN, zone: 0, dive: 1, goal: ys[r]!, onTarget: ys[r]! })
      kicks.push({ kicker: AGENT_SEAT, zone: 2, dive: 1, goal: ps[r]!, onTarget: ps[r]! })
    }
    const m: PenaltyMatch = { state: { seed: 1, kicks }, log: [] }
    expect(penaltyCore.terminal(m.state)).toBe(true)
    expect(penaltyCore.result(m.state)!.score).toEqual([3, 1])
    expect(resultLine(m, 'Pip')).toBe('You 3, Pip 1')
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

  test('a kick takes under 1.6 s and its beats run in order, with the skip open before the flight ends', () => {
    expect(CONTACT_MS).toBe(SET_MS + FLIGHT_MS)
    expect(SET_MS).toBeLessThan(CONTACT_MS)
    expect(CONTACT_MS).toBeLessThan(CLEAR_MS)
    expect(CLEAR_MS).toBeLessThan(KICK_MS)
    expect(KICK_MS).toBeLessThan(1600)
    // The word holds long enough to read.
    expect(CLEAR_MS - CONTACT_MS).toBeGreaterThanOrEqual(600)
    expect(SKIP_AFTER_MS).toBeLessThan(CONTACT_MS)
  })
})
