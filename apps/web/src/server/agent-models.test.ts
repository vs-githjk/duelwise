import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import type { GameId, Level } from '@duelwise/core/src/product'
import { getCore } from '@duelwise/core/src/games/index'
import { isLegal } from '@duelwise/core/src/games/holdem/match'
import { makeRng } from '@duelwise/core/src/rng'
import { createGameAgent } from '@duelwise/agents/src/agent-dispatch'
import { loadTable } from '@duelwise/agents/src/holdem/table'
import { CHECK_CLAIM_MS, checkAgentMoves, checkBudgetMs } from './agent-check'
import { isTimeCapped, makeServerAgent, publicBytes } from './agent-models'

/**
 * The shipped agents against the server's copy of them. The "page" side builds its agent the way the page does
 * (the agents package's own loader, or the table bytes for Hold'em, whose loader only fetches); the server side is
 * makeServerAgent. A record the first one plays must verify on the second, and a changed agent move must not.
 */
async function playWithShippedAgent(game: GameId, level: Level, seed: number, forgeAt?: number, humanSeat: 0 | 1 = 0): Promise<MatchRecordV1> {
  const core = getCore(game)
  const agentSeat = (1 - humanSeat) as 0 | 1
  const agent =
    game === 'holdem'
      ? await createGameAgent(game, level, { seat: 1, table: loadTable(new Uint8Array(readFileSync(new URL(`../../public/agents/holdem/v1/${level}.bin.gz`, import.meta.url)))) } as never)
      : await createGameAgent(game, level, { seat: 1 })
  expect(agent.preview).toBe(false)
  // The page builds its opponent before the server says which side the player has (seat 1), then re-seats it at reset.
  if (humanSeat === 0) agent.reset(seed)
  else agent.reset(seed, agentSeat)
  const human = makeRng(seed ^ 0x55)
  let s = core.init(seed)
  const actions: MatchRecordV1['actions'] = []
  let tick = 0
  let n = 0
  while (!core.terminal(s)) {
    const out: [unknown, unknown] = [null, null]
    for (const seat of core.toAct(s)) {
      let code: number
      if (seat === humanSeat) {
        const legal = core.legal(s, humanSeat).filter((a) => !(game === 'holdem' && core.encodeAction(a) === 2))
        code = core.encodeAction(legal[human.int(legal.length)])
      } else {
        const [raw] = await agent.act(core.observe(s, agentSeat), s)
        code = raw!
        if (game === 'holdem') {
          if (code === 2) code = 1
          if (!isLegal(s as never, 1, core.decodeAction(code) as never)) code = 1
        }
        if (n === forgeAt) code = core.encodeAction(core.legal(s, agentSeat).find((a) => core.encodeAction(a) !== code && !(game === 'holdem' && core.encodeAction(a) === 2))!)
        n++
      }
      actions.push([tick, seat, code])
      out[seat] = core.decodeAction(code)
    }
    s = core.step(s, out as never)
    tick++
  }
  agent.dispose()
  return {
    schema: 1, matchId: 'm', game, coreVersion: core.version, agent: { version: 'v1', level }, seed, humanSeat, actions, result: core.result(s)!, finalHash: core.hash(s),
    startedAt: '2026-10-23T10:00:00.000Z', endedAt: '2026-10-23T10:01:00.000Z', device: 'desktop', input: 'mouse', trainingAllowed: true,
  }
}

const server = (site: string | null = null) => ({ makeAgent: (g: GameId, l: Level, s: 0 | 1) => makeServerAgent(g, l, s, site), timeCapped: isTimeCapped })

for (const [game, level] of [['chess', 'medium'], ['chess', 'easy'], ['four', 'medium'], ['four', 'easy'], ['holdem', 'medium'], ['holdem', 'easy']] as const) {
  describe(`${game} ${level}: the server's copy of the shipped agent`, () => {
    test('replays a game the page agent played, move for move', async () => {
      const rec = await playWithShippedAgent(game, level, 31)
      expect(await checkAgentMoves(rec, server())).toEqual({ kind: 'verified' })
    })
    test('rejects the same game with one agent move changed', async () => {
      const rec = await playWithShippedAgent(game, level, 31, 1)
      expect((await checkAgentMoves(rec, server())).kind).toBe('forged')
    })
  })
}

// A player who has the second move (random sides, core/sides.ts): the opponent is seat 0 and opens. The page builds its opponent for seat 1 and re-seats it
// at reset; the server builds it for seat 0. Both must play the same moves, and a changed opening move must be caught.
for (const [game, level] of [['chess', 'hard'], ['chess', 'medium'], ['chess', 'easy'], ['four', 'hard'], ['four', 'medium'], ['four', 'easy']] as const) {
  describe(`${game} ${level}: the server's copy of the shipped agent when it moves first`, () => {
    test('replays a game the page agent opened, move for move', async () => {
      const rec = await playWithShippedAgent(game, level, 37, undefined, 1)
      expect(rec.humanSeat).toBe(1)
      expect(rec.actions[0]![1]).toBe(0)
      expect(await checkAgentMoves(rec, server())).toEqual({ kind: 'verified' })
    })
    test('rejects the same game with the opening move changed', async () => {
      const rec = await playWithShippedAgent(game, level, 37, 0, 1)
      expect((await checkAgentMoves(rec, server())).kind).toBe('forged')
    })
  })
}

describe('chess Champion: a node budget the server reproduces', () => {
  test('only the Four Champion is time-capped now; the chess Champion plays a fixed node budget', () => {
    expect(isTimeCapped('chess', 'champion')).toBe(false)
    expect(isTimeCapped('four', 'champion')).toBe(true)
    for (const l of ['easy', 'medium', 'hard'] as const) expect(isTimeCapped('chess', l)).toBe(false)
    for (const l of ['easy', 'medium', 'hard'] as const) expect(isTimeCapped('four', l)).toBe(false)
    expect(isTimeCapped('holdem', 'champion')).toBe(false)
  })

  test('the server starts the chess Champion with the same search as the page, and gives its check more time', async () => {
    const a = await makeServerAgent('chess', 'champion', 1, null)
    expect((a as { preview?: boolean }).preview).toBe(false)
    a.dispose()
    expect(checkBudgetMs('chess', 'champion')).toBeGreaterThan(checkBudgetMs('chess', 'hard'))
    expect(checkBudgetMs('chess', 'champion')).toBe(45_000)
    expect(CHECK_CLAIM_MS).toBe(75_000)
    expect(CHECK_CLAIM_MS).toBeGreaterThan(checkBudgetMs('chess', 'champion'))
  })

  let champRec: Promise<MatchRecordV1> | undefined
  const record = () => (champRec ??= playWithShippedAgent('chess', 'champion', 33))
  test('replays a Champion game the page played, move for move', async () => {
    expect(await checkAgentMoves(await record(), { ...server(), budgetMs: checkBudgetMs('chess', 'champion') })).toEqual({ kind: 'verified' })
  }, 180_000)
  test('rejects the same Champion game with an agent move changed', async () => {
    const rec = await playWithShippedAgent('chess', 'champion', 33, 0)
    expect((await checkAgentMoves(rec, { ...server(), budgetMs: checkBudgetMs('chess', 'champion') })).kind).toBe('forged')
  }, 180_000)

  test('there is no server opponent for the other games', async () => {
    await expect(makeServerAgent('word', 'easy', 1, null)).rejects.toThrow('no server copy')
  })
})

describe('publicBytes', () => {
  const origin = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === '/agents/test/served-only.bin' ? new Response(new Uint8Array([1, 2, 3])) : new Response('no', { status: 404 })) })
  afterAll(() => origin.stop(true))

  test('reads a file from the source tree', async () => {
    const bytes = await publicBytes('/agents/four/v1/easy.onnx', null)
    expect(bytes.length).toBeGreaterThan(1000)
  })
  test('falls back to the site when the file is not on disk, and says so when that fails too', async () => {
    expect([...(await publicBytes('/agents/test/served-only.bin', `http://localhost:${origin.port}`))]).toEqual([1, 2, 3])
    await expect(publicBytes('/agents/test/missing.bin', `http://localhost:${origin.port}`)).rejects.toThrow('HTTP 404')
    await expect(publicBytes('/agents/test/missing2.bin', null)).rejects.toThrow('no site URL')
  })
})
