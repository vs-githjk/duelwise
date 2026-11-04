import { describe, expect, test } from 'bun:test'
import type { GameId } from '@duelwise/core/src/product'
import { getCore } from '@duelwise/core/src/games/index'
import { checkAgentMoves } from './agent-check'
import { fakeAgent, play } from './agent-check-fixtures'

const make = (game: GameId, o: Parameters<typeof fakeAgent>[1] = {}) => async () => fakeAgent(game, o)

for (const game of ['chess', 'four', 'holdem', 'slack'] as const) {
  describe(`${game}: server re-run of the agent (H1)`, () => {
    test('an honest record is verified, and the server opponent is disposed', async () => {
      let disposed = 0
      const rec = await play(game, 11)
      const out = await checkAgentMoves(rec, { makeAgent: make(game, { onDispose: () => void disposed++ }) })
      expect(out).toEqual({ kind: 'verified' })
      expect(disposed).toBe(1)
    })

    test('a legal blunder by the agent (one action swapped for another legal one) is forged', async () => {
      for (const at of [0, 2]) {
        const rec = await play(game, 12, at)
        const out = await checkAgentMoves(rec, { makeAgent: make(game) })
        expect(out.kind, `forged at agent move ${at}`).toBe('forged')
      }
    })
  })
}

describe('what the check refuses to call verified', () => {
  test('a preview opponent (stub, no fixed play) is unverified', async () => {
    const rec = await play('four', 14)
    const out = await checkAgentMoves(rec, { makeAgent: make('four', { preview: true }) })
    expect(out.kind).toBe('unverified')
  })

  test('an opponent whose model cannot be loaded is unverified, with the reason', async () => {
    const rec = await play('four', 15)
    const out = await checkAgentMoves(rec, { makeAgent: async () => { throw new Error('model missing') } })
    expect(out).toMatchObject({ kind: 'unverified', reason: expect.stringContaining('model missing') })
  })

  test('running out of time is unverified, never verified (the cap)', async () => {
    const rec = await play('four', 16)
    let t = 0
    const out = await checkAgentMoves(rec, { makeAgent: make('four'), budgetMs: 100, now: () => (t += 60) })
    expect(out).toMatchObject({ kind: 'unverified', reason: expect.stringContaining('ran out of time') })
  })

  test('a difference at a time-capped level is unverified, not forged (the page cut its search by device speed)', async () => {
    const rec = await play('four', 17, 1)
    const out = await checkAgentMoves(rec, { makeAgent: make('four'), timeCapped: (g, l) => g === 'four' && l === 'hard' })
    expect(out.kind).toBe('unverified')
  })

  test('the agent throwing in the middle of a game is unverified, and still disposed', async () => {
    const rec = await play('four', 18)
    let disposed = 0
    const out = await checkAgentMoves(rec, {
      makeAgent: async () => ({ ...fakeAgent('four'), act: async () => { throw new Error('wasm trapped') }, dispose: () => void disposed++ }),
    })
    expect(out).toMatchObject({ kind: 'unverified', reason: expect.stringContaining('wasm trapped') })
    expect(disposed).toBe(1)
  })

  test('only a human in seat 0 can be checked, and real-time or Word Duel records are not checked here', async () => {
    const rec = await play('four', 19)
    // Hold'em is always seat 0. Four, chess and Crosscurrent have random sides (the finish step holds the record to the issued one), so the check itself
    // never calls a record that claims the wrong seat verified.
    const holdem = await play('holdem', 19)
    expect((await checkAgentMoves({ ...holdem, humanSeat: 1 }, { makeAgent: make('holdem') })).kind).toBe('unverified')
    expect((await checkAgentMoves({ ...rec, humanSeat: 1 }, { makeAgent: make('four') })).kind).not.toBe('verified')
    for (const game of ['word', 'fighter', 'arena'] as const) {
      expect((await checkAgentMoves({ ...rec, game }, { makeAgent: make('four') })).kind).toBe('unverified')
    }
  })
})
