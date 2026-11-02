import { describe, expect, test } from 'bun:test'
import { PASS, flipsFor, slackCore, type SlackObs, type SlackState } from '@duelwise/core/src/games/slack/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Seat } from '@duelwise/core/src/types'
import { createGameAgent } from './agent'
import { SLACK_LEVELS, chooseSlackAction, slackSearchOpts } from './levels'
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

describe('level parameters', () => {
  test('the four configs are the plan step 1 values', () => {
    expect(SLACK_LEVELS).toEqual({
      easy: { kind: 'greedy', cornerBonus: 20, randomPercent: 20 },
      medium: { kind: 'search', depth: 2, mobility: false, noise: 4 },
      hard: { kind: 'search', depth: 4, mobility: true, noise: 2 },
      champion: { kind: 'search', depth: 6, mobility: true, noise: 1, openingNoise: { above: 50, noise: 30 }, exactEmpties: 8, nodeCap: 120_000 },
    })
  })

  test("Sable's opening noise 30 holds at 51 empties and drops to 1 at 50, the gate sits exactly there", () => {
    const empties = (n: number) => positions(4000, 7).find((s) => s.cells.filter((c) => c === 0).length === n)!
    const at51 = empties(51)
    const at50 = empties(50)
    const rng = makeRng(1)
    expect(slackSearchOpts(SLACK_LEVELS.champion, obsOf(at51), rng).noise).toBe(30)
    expect(slackSearchOpts(SLACK_LEVELS.champion, obsOf(at50), rng).noise).toBe(1)
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
    // A position with one clear best placement (a corner with flips): Pip leaves it only on the random fifth, and then
    // the draw lands on the best too 1 time in k, so the off-best rate is 0.2 * (k - 1) / k.
    const greedy = (o: SlackObs, m: number) => flipsFor(o.cells, 1, m).length + (CORNERS.includes(m) ? 20 : 0)
    const found = positions(4000, 41).find((s) => {
      const o = obsOf(s)
      if (o.legal.length < 3 || o.legal[0] === PASS) return false
      const v = o.legal.map((m) => greedy(o, m)).sort((x, y) => y - x)
      return v[0]! > v[1]!
    })
    expect(found).toBeDefined()
    const o = obsOf(found!)
    const k = o.legal.length
    const best = o.legal.reduce((a, m) => (greedy(o, m) > greedy(o, a) ? m : a))
    const rng = makeRng(12)
    const n = 2000
    let off = 0
    for (let i = 0; i < n; i++) if (chooseSlackAction('easy', o, rng) !== best) off++
    const expected = (0.2 * (k - 1)) / k
    expect(off / n).toBeGreaterThan(expected - 0.04)
    expect(off / n).toBeLessThan(expected + 0.04)
  })

  test('breaks a tie between equal placements with the rng, not by position', () => {
    // The four opening placements flip one disc each: every one is the greedy best and each should be played about a quarter of the time.
    const o = obsOf(slackCore.init(0))
    const rng = makeRng(2)
    const count = new Map<number, number>()
    const n = 2000
    for (let i = 0; i < n; i++) {
      const c = chooseSlackAction('easy', o, rng)
      count.set(c, (count.get(c) ?? 0) + 1)
    }
    expect(count.size).toBe(4)
    for (const v of count.values()) {
      expect(v / n).toBeGreaterThan(0.18)
      expect(v / n).toBeLessThan(0.32)
    }
  })
})

describe('Sable', () => {
  test('never passes its node cap by more than one batch, on positions where the cap bites', () => {
    const cfg = SLACK_LEVELS.champion
    expect(cfg.kind).toBe('search')
    if (cfg.kind !== 'search') return
    const cap = cfg.nodeCap!
    expect(cap).toBe(120_000)
    // Vesper plays whole games (seeded); every Sable-to-move midgame position at 50 to 31 empties is searched with the options
    // the level really hands to the search, opening noise included. Games 0 to 4 hold several positions the cap cuts off.
    let worst = 0
    let capped = 0
    for (let g = 0; g < 5; g++) {
      const rng = makeRng(g + 1)
      let s = slackCore.init(0)
      let ply = 0
      while (!slackCore.terminal(s)) {
        const o = obsOf(s)
        const empties = o.cells.filter((c) => c === 0).length
        if (empties <= 50 && empties >= 31 && o.legal[0] !== PASS) {
          const r = searchMove(o.cells, 0, slackSearchOpts(cfg, o, makeRng(g * 100 + ply)))
          worst = Math.max(worst, r.nodes)
          if (r.nodes > cap) {
            capped++
            // The chooser takes the same path.
            expect(chooseSlackAction('champion', o, makeRng(g * 100 + ply))).toBe(r.move)
          }
        }
        s = act(s, chooseSlackAction('hard', o, rng))
        ply++
      }
    }
    expect(capped).toBeGreaterThanOrEqual(1)
    expect(worst).toBeLessThanOrEqual(cap + NODE_BATCH)
  }, 120_000)

  test('the last 8 empties are solved exactly, not by the depth 6 guess', () => {
    // Eight empties, mover owns the viewer discs. Depth 6 with mobility picks 23, the exact solve picks 8 (wins by 26 discs).
    const cells = Array.from('1021111102021110221121201211222210212222112221221122222110202222', Number)
    const o = obsOf({ cells, turn: 0 })
    expect(cells.filter((c) => c === 0).length).toBe(8)
    expect(searchMove(cells, 0, { maxDepth: 6, mobility: true }).move).toBe(23)
    expect(searchMove(cells, 0, { maxDepth: 6, mobility: true, exactEmpties: 8 }).move).toBe(8)
    for (let seed = 1; seed <= 20; seed++) expect(chooseSlackAction('champion', o, makeRng(seed))).toBe(8)
  })

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
