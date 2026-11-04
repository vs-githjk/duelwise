import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { replay } from '@duelwise/core/src/replay'
import { PASS, slackCore } from '@duelwise/core/src/games/slack/core'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent } from '@duelwise/agents/src/agent-dispatch'
import { createGameAgent as createSlackAgent } from '@duelwise/agents/src/slack/agent'
import { SLACK_LEVELS } from '@duelwise/agents/src/slack/levels'
import { searchMove } from '@duelwise/agents/src/slack/search'
import { makeRng } from '@duelwise/core/src/rng'
import { checkAgentMoves, SERVER_CHECKED } from './agent-check'
import { isTimeCapped, makeServerAgent } from './agent-models'

// The server re-runs Crosscurrent's opponent with the factory the page's worker uses. These tests play whole matches through the page's path
// and check them through the server's path, so a difference in code, options or any clock reading shows up as a record the server refuses.

const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']

/** A whole match as the page plays it: the opponent answers in the worker's way (fresh factory call, seat 1, reset, an observation that crossed a structured clone). */
async function pagePlay(level: Level, seed: number, human: Level | 'random', forge?: { at: number }): Promise<MatchRecordV1> {
  const ai = await createSlackAgent(level, { seat: 1 })
  ai.reset(seed)
  const rng = makeRng(seed ^ 0x77)
  const person = human === 'random' ? null : await createSlackAgent(human, { seat: 0 })
  person?.reset(seed + 1)
  let s = slackCore.init(seed)
  const actions: MatchRecordV1['actions'] = []
  let tick = 0
  let aiMoves = 0
  while (!slackCore.terminal(s)) {
    const seat = slackCore.toAct(s)[0]!
    let code: number
    if (seat === 0) {
      code = person ? (await person.act(slackCore.observe(s, 0)))[0]! : slackCore.encodeAction(slackCore.legal(s, 0)[rng.int(slackCore.legal(s, 0).length)])
    } else {
      code = (await ai.act(structuredClone(slackCore.observe(s, 1))))[0]!
      if (forge && aiMoves === forge.at) code = slackCore.legal(s, 1).map((a) => slackCore.encodeAction(a)).find((c) => c !== code)!
      aiMoves++
    }
    actions.push([tick++, seat, code])
    s = slackCore.step(s, seat === 0 ? [slackCore.decodeAction(code), null] : [null, slackCore.decodeAction(code)])
  }
  const rec: MatchRecordV1 = {
    schema: 1, matchId: 'm', game: 'slack', coreVersion: slackCore.version, agent: { version: 'v1', level }, seed, humanSeat: 0, actions,
    result: slackCore.result(s)!, finalHash: slackCore.hash(s), startedAt: '2026-11-03T10:00:00.000Z', endedAt: '2026-11-03T10:01:00.000Z',
    device: 'desktop', input: 'mouse', trainingAllowed: false,
  }
  expect(replay(rec).ok).toBe(true)
  return rec
}

const serverCheck = (rec: MatchRecordV1) => checkAgentMoves(rec, { makeAgent: (g, l, seat) => makeServerAgent(g, l, seat, null), timeCapped: isTimeCapped, budgetMs: 120_000 })

describe('Crosscurrent is a server-checked game with no time cap', () => {
  test('it is listed, and no level is time-capped, so any difference is proof and never a shrug', () => {
    expect(SERVER_CHECKED).toContain('slack')
    for (const l of LEVELS) expect(isTimeCapped('slack', l)).toBe(false)
  })

  test('the server builds the opponent without any model file or site fetch', async () => {
    for (const l of LEVELS) {
      const a = await makeServerAgent('slack', l, 1, null)
      expect(a.preview).toBe(false)
      a.dispose()
    }
  })
})

describe('the AI the browser runs is the AI the server checks', () => {
  test('the page worker and the server build the opponent from the same factory with the same options', () => {
    const worker = readFileSync(join(import.meta.dir, '..', 'games', 'slack', 'worker.ts'), 'utf8')
    const models = readFileSync(join(import.meta.dir, 'agent-models.ts'), 'utf8')
    expect(worker).toContain("from '@duelwise/agents/src/slack/agent'")
    expect(worker).toContain('createGameAgent(msg.level, { seat: msg.seat ?? 1 })')
    expect(models).toContain("createGameAgent('slack', level, { seat })")
  })

  test('the dispatch the server uses resolves to the module the worker imports', async () => {
    const a = await createGameAgent('slack', 'hard', { seat: 1 })
    const b = await createSlackAgent('hard', { seat: 1 })
    for (const x of [a, b]) x.reset(4242)
    const state = slackCore.init(4242)
    // The opponent is seat 1, so show it the position after one human move.
    const first = slackCore.legal(state, 0)[0]
    const s1 = slackCore.step(state, [first, null])
    const obs = slackCore.observe(s1, 1)
    expect(await a.act(obs)).toEqual(await b.act(structuredClone(obs)))
  })

  for (const [level, human, seeds] of [['easy', 'random', [11, 12, 13, 14]], ['medium', 'random', [21, 22, 23]], ['hard', 'easy', [31, 32, 33]], ['champion', 'hard', [41, 42]], ['champion', 'random', [43]]] as const) {
    for (const seed of seeds) {
      test(`${level} against ${human}, seed ${seed}: a match played through the page's path is verified by the server`, async () => {
        const rec = await pagePlay(level, seed, human)
        expect(await serverCheck(rec)).toEqual({ kind: 'verified' })
      })
    }
  }

  test('a forced pass for the opponent is checked too: the match here contains one and is verified', async () => {
    // Find a seed whose match holds an opponent pass, so the pass branch (no rng draw) is proven to line up.
    for (let seed = 100; seed < 200; seed++) {
      const rec = await pagePlay('easy', seed, 'random')
      if (rec.actions.some(([, seat, a]) => seat === 1 && a === PASS)) {
        expect(await serverCheck(rec)).toEqual({ kind: 'verified' })
        return
      }
    }
    throw new Error('no match with an opponent pass in 100 seeds')
  })
})

describe('forged records are refused', () => {
  for (const level of LEVELS) {
    test(`${level}: one legal opponent move swapped for another is forged, wherever it is`, async () => {
      for (const at of [0, 3]) {
        const rec = await pagePlay(level, 51 + at, level === 'champion' ? 'hard' : 'random', { at })
        const out = await serverCheck(rec)
        expect(out.kind, `${level} forged at opponent move ${at}`).toBe('forged')
      }
    })
  }

  test('a win built by replacing the opponent\'s whole game with the human\'s own moves is forged', async () => {
    // The human plays both sides against itself: a legal game, the opponent never played its moves.
    const seed = 61
    const rng = makeRng(9)
    let s = slackCore.init(seed)
    const actions: MatchRecordV1['actions'] = []
    let tick = 0
    while (!slackCore.terminal(s)) {
      const seat = slackCore.toAct(s)[0]!
      const legal = slackCore.legal(s, seat)
      const a = legal[rng.int(legal.length)]
      actions.push([tick++, seat, slackCore.encodeAction(a)])
      s = slackCore.step(s, seat === 0 ? [a, null] : [null, a])
    }
    const rec: MatchRecordV1 = { ...(await pagePlay('hard', seed, 'random')), actions, result: slackCore.result(s)!, finalHash: slackCore.hash(s) }
    expect((await serverCheck(rec)).kind).toBe('forged')
  })
})

describe('no clock decides a move, so the same code gives the same move on any machine', () => {
  const dir = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'agents', 'src', 'slack')
  const shipped = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !['dry-ladder.ts', 'measure.ts'].includes(f))

  test('the shipped files of the agent read no clock, no timer and no unseeded random', () => {
    expect(shipped).toEqual(expect.arrayContaining(['agent.ts', 'board.ts', 'levels.ts', 'search.ts']))
    for (const f of shipped) {
      const code = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code, f).not.toMatch(/Date\b|performance\b|setTimeout|setInterval|Math\.random|hrtime|requestAnimationFrame|timeCapMs/)
    }
  })

  test('Sable\'s cap is a node count that binds on real positions, and the move and node count do not depend on what ran before or on any clock reading', () => {
    const cfg = SLACK_LEVELS.champion
    if (cfg.kind !== 'search') throw new Error('champion is a search level')
    // Positions from a real game: walk a seeded match and keep the positions where the cap binds.
    const rng = makeRng(5150)
    let s = slackCore.init(1)
    const positions: number[][] = []
    const mover: Array<0 | 1> = []
    while (!slackCore.terminal(s) && positions.length < 40) {
      const seat = slackCore.toAct(s)[0]!
      const legal = slackCore.legal(s, seat)
      if (!(legal.length === 1 && slackCore.encodeAction(legal[0]) === PASS)) {
        positions.push([...(s as { cells: number[] }).cells])
        mover.push(seat as 0 | 1)
      }
      const a = legal[rng.int(legal.length)]
      s = slackCore.step(s, seat === 0 ? [a, null] : [null, a])
    }
    // Sable's own cap rarely binds on a random walk, so the proof also runs a cap small enough to bind on most positions: the same code path, a stricter test.
    for (const nodeCap of [cfg.nodeCap!, 4_000]) {
      const opts = (seed: number) => ({ maxDepth: cfg.depth, mobility: cfg.mobility, noise: cfg.noise, exactEmpties: cfg.exactEmpties, nodeCap, rng: makeRng(seed) })
      const clean = positions.map((c, i) => searchMove(c, mover[i]!, opts(i)))
      if (nodeCap === 4_000) expect(clean.filter((r) => r.nodes >= nodeCap).length, 'the cap must bind on many positions, or this proves nothing').toBeGreaterThan(10)
      for (const r of clean) expect(r.nodes).toBeLessThanOrEqual(nodeCap + 1)
      // Warm caches, run in reverse order, and make every clock wildly wrong: nothing may change.
      const realNow = Date.now
      const realPerf = performance.now.bind(performance)
      let tick = 0
      Date.now = () => (tick += 7_919_001)
      performance.now = () => (tick += 3_000_017)
      try {
        for (let i = positions.length - 1; i >= 0; i--) {
          const again = searchMove(positions[i]!, mover[i]!, opts(i))
          expect(again, `cap ${nodeCap}, position ${i}`).toEqual(clean[i]!)
        }
      } finally {
        Date.now = realNow
        performance.now = realPerf
      }
    }
  })

  test('a whole Sable match checks the same when every clock the server could read is frozen or racing', async () => {
    const rec = await pagePlay('champion', 71, 'hard')
    const realNow = Date.now
    const realPerf = performance.now.bind(performance)
    try {
      Date.now = () => 1_000
      performance.now = () => 1_000
      // The check's own deadline uses its injected clock; the agent must not read these.
      expect(await checkAgentMoves(rec, { makeAgent: (g, l, seat) => makeServerAgent(g, l, seat, null), budgetMs: 600_000, now: () => 0 })).toEqual({ kind: 'verified' })
    } finally {
      Date.now = realNow
      performance.now = realPerf
    }
  })
})
