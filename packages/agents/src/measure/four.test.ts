import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { fourEncoder } from '@duelwise/core/src/games/four/encode'
import { fourFromMoves, type FourState } from '@duelwise/core/src/games/four/rules'
import { solve } from '@duelwise/core/src/games/four/solver'
import { makeRng } from '@duelwise/core/src/rng'
import type { Level } from '@duelwise/core/src/product'
import { createAgent } from '../runtime/agent'
import { createOnnxEvaluator } from '../mcts/onnx-evaluator'
import { EASY_TEMPERATURE, FOUR_LEVELS, createGameAgent } from '../four/agent'
import { createOpeningCore, optimalRates, positionsHash, type SolvedPosition } from './four'

const REPO = join(import.meta.dir, '..', '..', '..', '..')
const V1 = join(REPO, 'apps', 'web', 'public', 'agents', 'four', 'v1')
const EVAL = join(REPO, 'packages', 'agents', 'eval')
const modelBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(V1, name)))

/** 20 fixed non-terminal positions, 3 to 32 stones in. */
function fixedPositions(): FourState[] {
  const rng = makeRng(2323)
  const out: FourState[] = []
  while (out.length < 20) {
    const target = 3 + out.length + (out.length % 3)
    let s = fourFromMoves([])
    while (!fourCore.terminal(s) && s.n < target) {
      const legal = fourCore.legal(s, fourCore.toAct(s)[0]!)
      s = fourCore.step(s, fourCore.toAct(s)[0] === 0 ? [legal[rng.int(legal.length)]!, null] : [null, legal[rng.int(legal.length)]!])
    }
    if (!fourCore.terminal(s)) out.push(s)
  }
  return out
}

const actFor = async (agent: { act: (o: unknown, s?: unknown) => Promise<number[]>; reset: (seed: number) => void }, states: FourState[]): Promise<number[]> => {
  const moves: number[] = []
  for (const [i, s] of states.entries()) {
    agent.reset(500 + i)
    moves.push((await agent.act(fourCore.observe(s, fourCore.toAct(s)[0]!), s))[0]!)
  }
  return moves
}

// Bun cannot create a Web Worker in a process whose main thread has already run an ORT wasm session (see
// runtime/ort-session.test.ts), so the worker path runs first in this file.
describe('four agent: worker path and harness path', () => {
  const states = fixedPositions()
  const levels: Level[] = ['easy', 'medium', 'hard']
  const viaWorker: Partial<Record<Level, number[]>> = {}

  test('createAgent in a worker plays legal moves on 20 fixed positions', async () => {
    for (const level of levels) {
      const agent = await createAgent('four', level, { seat: 0 })
      expect(agent.preview).toBe(false)
      viaWorker[level] = await actFor(agent, states)
      agent.dispose()
      states.forEach((s, i) => expect(fourCore.legal(s, fourCore.toAct(s)[0]!)).toContain(viaWorker[level]![i]!))
    }
  }, 120_000)

  test('the factory the harness uses chooses the same moves as the worker', async () => {
    for (const level of levels) {
      const agent = await createGameAgent(level, { seat: 0 })
      expect(await actFor(agent, states)).toEqual(viaWorker[level]!)
      agent.dispose()
    }
  }, 120_000)

  test('an observation without the state gives the same move', async () => {
    const agent = await createGameAgent('hard', { seat: 0 })
    for (const [i, s] of states.slice(0, 6).entries()) {
      const obs = fourCore.observe(s, fourCore.toAct(s)[0]!)
      agent.reset(500 + i)
      const a = await agent.act(obs, s)
      agent.reset(500 + i)
      expect(await agent.act(obs)).toEqual(a)
    }
    agent.dispose()
  }, 60_000)
})

describe('OnnxEvaluator', () => {
  test('equals the Python net within 1e-5 on the parity fixture', async () => {
    const fixture = JSON.parse(readFileSync(join(EVAL, 'four-parity.json'), 'utf8')) as {
      tolerance: number
      model: string
      positions: Array<{ moves: number[]; logits: number[]; value: number }>
    }
    expect(fixture.tolerance).toBe(1e-5)
    expect(fixture.positions.length).toBeGreaterThanOrEqual(10)
    const ev = await createOnnxEvaluator({ core: fourCore, encoder: fourEncoder, actionCount: 7, model: modelBytes(fixture.model) })
    const states = fixture.positions.map((p) => fourFromMoves(p.moves))
    const { logits, values } = await ev.raw(states)
    let worst = 0
    fixture.positions.forEach((p, i) => {
      for (let c = 0; c < 7; c++) worst = Math.max(worst, Math.abs(logits[i * 7 + c]! - p.logits[c]!))
      worst = Math.max(worst, Math.abs(values[i]! - p.value))
    })
    expect(worst).toBeLessThan(1e-5)
    // One position at a time equals the batch.
    const single = await ev.raw([states[3]!])
    for (let c = 0; c < 7; c++) expect(Math.abs(single.logits[c]! - logits[3 * 7 + c]!)).toBeLessThan(1e-5)
    // The evaluator masks to legal columns and renormalises.
    const [e] = await ev.evaluate([states[0]!])
    expect(Array.from(e!.priors).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5)
    ev.dispose()
  })
})

describe('Four in a Row levels and measurement helpers', () => {
  test('Easy temperature matches the one the checkpoint picker uses', () => {
    const py = readFileSync(join(REPO, 'training', 'trainer', 'four', 'pick_levels.py'), 'utf8')
    expect(py).toContain(`EASY_TEMPERATURE = ${EASY_TEMPERATURE}\n`)
    // A9 retune: Pip looks six simulations ahead (it was 0), Marlow none (it was 24), each tuned to its band against the people panel.
    expect(FOUR_LEVELS.easy.sims).toBe(6)
    expect(FOUR_LEVELS.medium.sims).toBe(0)
    expect(FOUR_LEVELS.champion.sims).toBe(800)
  })

  test('the Champion answers the human centre opening with the centre on every seed (judge round 2: the opening rule must not trade it away)', async () => {
    const opening = FOUR_LEVELS.champion.variety!.opening!
    // The loose pick must not cover the reply to the first stone (stone 1) nor stay near the old 0.5 margin.
    expect(opening.from).toBeGreaterThanOrEqual(2)
    expect(opening.valueMargin).toBeLessThanOrEqual(0.25)
    const agent = await createGameAgent('champion', { seat: 1 })
    const s = fourFromMoves([3])
    const replies: number[] = []
    for (let seed = 0; seed < 8; seed++) {
      agent.reset(seed)
      replies.push((await agent.act(fourCore.observe(s, 1), s))[0]!)
    }
    agent.dispose()
    expect(replies.filter((c) => c === 3).length).toBeGreaterThanOrEqual(7)
  }, 120_000)

  test('the Champion only varies inside the solver-proven moves from stone 12, and the loose opening tier is gone (judge round 2 fix 1)', async () => {
    const v = FOUR_LEVELS.champion.variety!
    expect(v.solverFrom).toBe(12)
    expect(v.opening!.plies).toBeLessThanOrEqual(v.solverFrom!)
    expect(v.opening!.valueMargin).toBeLessThanOrEqual(0.1)
    expect(v.opening!.keepShare).toBeGreaterThanOrEqual(0.05)
    // Two positions with 14 stones that are won for the side to move: every seeded Champion move is one the weak solver keeps.
    const agent = await createGameAgent('champion', { seat: 1, search: { sims: 60, timeCapMs: undefined } })
    for (const line of [[0, 6, 5, 0, 5, 2, 1, 1, 1, 3, 0, 2, 5, 4], [4, 6, 1, 6, 0, 6, 2, 4, 0, 5, 5, 4, 2, 2]]) {
      const s = fourFromMoves(line)
      const keep = solve(s, { weak: true }).bestMoves
      for (let seed = 0; seed < 12; seed++) {
        agent.reset(seed)
        expect(keep).toContain((await agent.act(fourCore.observe(s, 0), s))[0]!)
      }
    }
    agent.dispose()
  }, 120_000)

  test('the opening core gives the colour-swapped pair one opening of 2 plies, and never starts terminal', () => {
    const core = createOpeningCore()
    expect(core.init(10).n).toBe(2)
    expect(core.init(10)).toEqual(core.init(11))
    expect(core.init(10)).toEqual(core.init(10))
    expect(new Set(Array.from({ length: 30 }, (_, k) => core.hash(core.init(2 * k)))).size).toBeGreaterThan(8)
  })

  test('the committed test positions are fixed and their solver answers still hold', () => {
    const file = JSON.parse(readFileSync(join(EVAL, 'four-positions.json'), 'utf8')) as { count: number; hash: string; positions: SolvedPosition[] }
    expect(file.positions.length).toBe(1000)
    expect(file.count).toBe(1000)
    expect(positionsHash(file.positions)).toBe(file.hash)
    for (const p of file.positions.filter((_, i) => i % 125 === 0)) {
      const s = fourFromMoves(p.moves)
      expect(solve(s, { weak: true }).bestMoves).toEqual(p.holdMoves)
      expect(p.optimalMoves.every((m) => p.holdMoves.includes(m) || p.score < 0)).toBe(true)
    }
  }, 120_000)

  test('optimalRates counts a move as optimal only when the solver lists it', () => {
    const positions: SolvedPosition[] = [
      { moves: [], score: 1, optimalMoves: [3], holdMoves: [3] },
      { moves: [], score: 0, optimalMoves: [2], holdMoves: [2, 3] },
    ]
    expect(optimalRates(positions, [3, 3])).toEqual({ optimal: 0.5, hold: 1, n: 2 })
    expect(optimalRates(positions, [0, 0])).toEqual({ optimal: 0, hold: 0, n: 2 })
  })
})

describe('the agent serves what the registry says is live', () => {
  test('every level reads the model file, in the folder, that the registry names for its version, and the hash matches', () => {
    const reg = JSON.parse(readFileSync(join(REPO, 'packages', 'agents', 'registry', 'four.json'), 'utf8')) as {
      versions: { version: string; artifacts: Record<string, string>; sha256: Record<string, string> }[]
      levels: Record<string, { version: string }>
    }
    for (const level of Object.keys(FOUR_LEVELS) as Level[]) {
      const version = reg.versions.find((v) => v.version === reg.levels[level]!.version)!
      const cfg = FOUR_LEVELS[level]
      const expected = `apps/web/public${cfg.base ?? '/agents/four/v1'}/${cfg.model}`
      expect(version.artifacts[level]).toBe(expected)
      const bytes = readFileSync(join(REPO, expected))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(version.sha256[level])
    }
  })
})
