import { describe, expect, test } from 'bun:test'
import { PASS, slackCore, type SlackObs, type SlackState } from '@duelwise/core/src/games/slack/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Seat } from '@duelwise/core/src/types'
import { createGameAgent } from './agent'
import { SLACK_LEVELS, chooseSlackAction } from './levels'
import { searchMove, NODE_BATCH } from './search'

const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']
const CORNERS = [0, 7, 56, 63]

function act(s: SlackState, a: number): SlackState {
  const x: [number | null, number | null] = [null, null]
  x[s.turn] = a
  return slackCore.step(s, x)
}

/** States of seeded random matches, one per ply, up to `count`. */
function positions(count: number, seed: number): SlackState[] {
  const rng = makeRng(seed)
  const out: SlackState[] = []
  while (out.length < count) {
    let s = slackCore.init(0)
    while (!slackCore.terminal(s) && out.length < count) {
      out.push(s)
      const legal = slackCore.legal(s, s.turn)
      s = act(s, legal[rng.int(legal.length)]!)
    }
  }
  return out
}

function obsOf(s: SlackState): SlackObs {
  return slackCore.observe(s, s.turn)
}

describe('every level plays a legal code', () => {
  test('300 positions per level, passes included, from the chooser and from the agent', async () => {
    const states = positions(300, 11)
    expect(states.some((s) => slackCore.legal(s, s.turn)[0] === PASS)).toBe(true)
    for (const level of LEVELS) {
      const agent = await createGameAgent(level, { seat: 0 })
      expect(agent.preview).toBe(false)
      agent.reset(5)
      const rng = makeRng(3)
      for (const s of states) {
        const legal = slackCore.legal(s, s.turn)
        const seat = s.turn
        const code = chooseSlackAction(level, obsOf(s), rng)
        expect(legal).toContain(code)
        const [viaAgent] = await createGameAgent(level, { seat }).then(async (a) => {
          a.reset(9)
          const r = await a.act(obsOf(s))
          a.dispose()
          return r
        })
        expect(legal).toContain(viaAgent!)
      }
      agent.dispose()
    }
  }, 120_000)

  test('a seat with only a pass gets the pass code', () => {
    // Seat 1's lone disc sits in a corner, so seat 0 closes no line; seat 1 can still take cell 2.
    const cells = new Array<number>(64).fill(0)
    cells[0] = 2
    cells[1] = 1
    const s: SlackState = { cells, turn: 0 }
    expect(slackCore.legal(s, 0)).toEqual([PASS])
    for (const level of LEVELS) expect(chooseSlackAction(level, obsOf(s), makeRng(1))).toBe(PASS)
  })

  test('it refuses an observation where the seat is not to move', () => {
    const s = slackCore.init(0)
    const wrong = slackCore.observe(s, (1 - s.turn) as Seat)
    expect(() => chooseSlackAction('easy', wrong, makeRng(1))).toThrow()
  })
})

describe('the answer depends only on the observation and the rng', () => {
  test('same observation and seed give the same code, a repeat call changes nothing', async () => {
    const states = positions(120, 21)
    for (const level of LEVELS) {
      for (const s of states.filter((x) => slackCore.legal(x, x.turn).length > 0)) {
        const o = obsOf(s)
        const a = chooseSlackAction(level, o, makeRng(77))
        const b = chooseSlackAction(level, structuredClone(o), makeRng(77))
        expect(b).toBe(a)
      }
    }
    // The agent: same seed and seat, same replies; no state carried between calls beyond the rng.
    const s = states[40]!
    const o = obsOf(s)
    const one = await createGameAgent('hard', { seat: s.turn })
    const two = await createGameAgent('hard', { seat: s.turn })
    one.reset(4)
    two.reset(4)
    expect(await one.act(o)).toEqual(await two.act(o))
    one.dispose()
    two.dispose()
  }, 120_000)

  test('the seat is mixed into the seed', async () => {
    // Two seats given the same seed draw different noise: over many positions the replies must differ somewhere.
    const states = positions(200, 31).filter((s) => slackCore.legal(s, s.turn).length > 2)
    const a0 = await createGameAgent('easy', { seat: 0 })
    const a1 = await createGameAgent('easy', { seat: 1 })
    a0.reset(8)
    a1.reset(8)
    let differ = 0
    for (const s of states) {
      const o = obsOf(s)
      if ((await a0.act(o))[0] !== (await a1.act(o))[0]) differ++
    }
    expect(differ).toBeGreaterThan(0)
    a0.dispose()
    a1.dispose()
  })
})

describe('Pip', () => {
  test('takes a free corner far more often than chance over 200 positions', () => {
    const states = positions(4000, 41).filter((s) => {
      const legal = slackCore.legal(s, s.turn)
      return legal.some((m) => CORNERS.includes(m)) && legal.some((m) => !CORNERS.includes(m))
    })
    expect(states.length).toBeGreaterThanOrEqual(200)
    const rng = makeRng(5)
    let taken = 0
    let chance = 0
    for (const s of states.slice(0, 200)) {
      const legal = slackCore.legal(s, s.turn)
      chance += legal.filter((m) => CORNERS.includes(m)).length / legal.length
      if (CORNERS.includes(chooseSlackAction('easy', obsOf(s), rng))) taken++
    }
    // Chance is the share of corners among the legal moves; Pip's pull plus a fifth of random play beats it by a wide margin.
    expect(taken).toBeGreaterThan(chance * 2.5)
    expect(taken).toBeGreaterThan(110)
  })

  test('plays a random legal move about a fifth of the time', () => {
    // On the opening position the four placements flip one disc each; greedy ties are broken by the rng, so all four show.
    const o = obsOf(slackCore.init(0))
    const rng = makeRng(2)
    const seen = new Set<number>()
    for (let i = 0; i < 100; i++) seen.add(chooseSlackAction('easy', o, rng))
    expect(seen.size).toBe(4)
  })
})

describe('Sable', () => {
  test('never passes its node cap by more than one batch', () => {
    const cfg = SLACK_LEVELS.champion
    expect(cfg.kind).toBe('search')
    if (cfg.kind !== 'search') return
    const cap = cfg.nodeCap ?? Infinity
    expect(cap).toBe(120_000)
    const rng = makeRng(6)
    let worst = 0
    for (const s of positions(160, 51).filter((x) => slackCore.legal(x, x.turn)[0] !== PASS)) {
      const r = searchMove(s.cells, s.turn, {
        maxDepth: cfg.depth,
        mobility: cfg.mobility,
        noise: cfg.noise,
        rng,
        exactEmpties: cfg.exactEmpties,
        nodeCap: cap,
      })
      worst = Math.max(worst, r.nodes)
    }
    expect(worst).toBeLessThanOrEqual(cap + NODE_BATCH)
  }, 120_000)

  test('against one scripted opening line its first four moves differ across seeds', async () => {
    const sequences = new Set<string>()
    for (let seed = 1; seed <= 50; seed++) {
      const agent = await createGameAgent('champion', { seat: 1 })
      agent.reset(seed)
      let s = slackCore.init(0)
      const mine: number[] = []
      while (mine.length < 4 && !slackCore.terminal(s)) {
        if (s.turn === 0) {
          // The fixed opponent: lowest-numbered placement, always the same line.
          s = act(s, slackCore.legal(s, 0)[0]!)
        } else {
          const [code] = await agent.act(obsOf(s))
          mine.push(code!)
          s = act(s, code!)
        }
      }
      sequences.add(mine.join(','))
      agent.dispose()
    }
    expect(sequences.size).toBeGreaterThanOrEqual(5)
  }, 120_000)
})
