import { expect } from 'bun:test'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import type { GameId } from '@duelwise/core/src/product'
import { getCore } from '@duelwise/core/src/games/index'
import { makeRng } from '@duelwise/core/src/rng'
import type { Seat } from '@duelwise/core/src/types'
import { replay } from '@duelwise/core/src/replay'
import type { CheckAgent } from './agent-check'

/** A deterministic stand-in opponent: draws a legal action from a stream seeded by reset(), like the shipped agents do. */
export function fakeAgent(game: GameId, opts: { preview?: boolean; onDispose?: () => void } = {}): CheckAgent {
  const core = getCore(game)
  let rng = makeRng(0)
  return {
    preview: opts.preview ?? false,
    reset(seed) {
      rng = makeRng(seed ^ 0x5bd1e995)
    },
    async act(_obs, state) {
      const legal = core.legal(state as never, 1)
      return [core.encodeAction(legal[rng.int(legal.length)])]
    },
    dispose() {
      opts.onDispose?.()
    },
  }
}

/** Plays a whole game: a random human in seat 0 and the fake agent in seat 1. `forgeAt` swaps the n-th agent action for another legal one. */
export async function play(game: GameId, seed: number, forgeAt?: number, level: MatchRecordV1['agent']['level'] = 'hard', matchId = 'm', options?: MatchRecordV1['options']): Promise<MatchRecordV1> {
  const core = getCore(game)
  const agent = fakeAgent(game)
  agent.reset(seed)
  const human = makeRng(seed ^ 0x77)
  let s = core.init(seed, options)
  const actions: MatchRecordV1['actions'] = []
  let tick = 0
  let agentMoves = 0
  while (!core.terminal(s)) {
    const out: [unknown, unknown] = [null, null]
    for (const seat of core.toAct(s)) {
      let code: number
      if (seat === 0) {
        // The random human never concedes in Hold'em (code 2), so every game runs long enough to hold agent moves.
        const legal = core.legal(s, 0).filter((a) => !(game === 'holdem' && core.encodeAction(a) === 2))
        code = core.encodeAction(legal[human.int(legal.length)])
      } else {
        const [raw] = await agent.act(core.observe(s, 1), s)
        code = raw!
        // Hold'em: the page plays a concede as a call.
        if (game === 'holdem' && code === 2) code = 1
        if (agentMoves === forgeAt) {
          const others = core.legal(s, 1).map((a) => core.encodeAction(a)).filter((c) => c !== code && !(game === 'holdem' && c === 2))
          code = others[0]!
        }
        agentMoves++
      }
      actions.push([tick, seat as Seat, code])
      out[seat] = core.decodeAction(code)
    }
    s = core.step(s, out as [never, never])
    tick++
  }
  if (forgeAt !== undefined && agentMoves <= forgeAt) throw new Error(`the game had only ${agentMoves} agent moves, none to forge at ${forgeAt}`)
  const rec: MatchRecordV1 = {
    schema: 1, matchId, game, coreVersion: core.version, agent: { version: 'v1', level }, seed, humanSeat: 0, actions,
    result: core.result(s)!, finalHash: core.hash(s), startedAt: '2026-10-23T10:00:00.000Z', endedAt: '2026-10-23T10:01:00.000Z',
    device: 'desktop', input: 'mouse', trainingAllowed: true, ...(options ? { options } : {}),
  }
  expect(replay(rec).ok).toBe(true) // a forged record is still a legal game: that is the hole
  return rec
}

