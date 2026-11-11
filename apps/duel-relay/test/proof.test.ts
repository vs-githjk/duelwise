import { describe, expect, test } from 'bun:test'
import { verifyDuelResult } from '@duelwise/core/src/duel/result-proof'
import type { Seat } from '@duelwise/core/src/types'
import { ADA, PID_ADA, PID_SAM, SAM, TEST_SECRET, act, connect, hostOf, rig, sync, type Rig } from './helpers'

const adaId = { ...ADA, pid: PID_ADA, rt: { four: 1240, chess: 1000 } }
const samId = { ...SAM, pid: PID_SAM }

async function playOut(r: Rig, guard = 3000): Promise<void> {
  for (let i = 0; i < guard && r.last[0]?.status !== 'over'; i++) {
    for (const s of [0, 1] as const) {
      await sync(r, s)
      const v = r.last[s]
      if (v.canAct) await act(r, s, v.legal[0], v.n)
    }
  }
}

async function start(game: 'four' | 'chess' = 'four') {
  const r = rig({ hostSeat: 0 })
  await connect(r, hostOf(adaId, game))
  await connect(r, samId)
  return r
}

describe('the relay signs the finished result (head-to-head)', () => {
  test('both seats get the same proof with the final view; it verifies, names the two players and the winner, and holds no seed or move', async () => {
    const r = await start()
    await playOut(r)
    expect(r.proofs[0].length).toBeGreaterThan(0)
    expect(r.proofs[0].at(-1)).toBe(r.proofs[1].at(-1))
    const rec = await verifyDuelResult(r.proofs[0].at(-1), TEST_SECRET)
    expect(rec).not.toBeNull()
    expect(rec!.game).toBe('four')
    expect(rec!.players.map((p) => p.pid)).toEqual([PID_ADA, PID_SAM])
    expect(rec!.players.map((p) => p.name)).toEqual(['Ada', 'Sam'])
    expect(rec!.players[0].rating).toBe(1240)
    expect(rec!.players[1].rating).toBeUndefined()
    expect(rec!.winner).toBe(r.last[0].result.winner)
    const room = r.host.peek().room!
    const text = r.proofs[0].at(-1)!
    const b = text.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(b + '='.repeat((4 - (b.length % 4)) % 4))
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(['at', 'game', 'id', 'k', 'players', 'v', 'winner'])
    expect(json.includes(String(room.seed))).toBe(false)
  })

  test('no proof before the game ends', async () => {
    const r = await start()
    await sync(r, 0)
    await sync(r, 1)
    expect(r.proofs[0]).toEqual([])
    expect(r.proofs[1]).toEqual([])
  })

  test('a resignation is signed for the other seat; a rematch ends with a different id', async () => {
    const r = await start()
    const first = r.host.peek().room!
    r.clock.t += 200
    r.take(await r.msg(0, JSON.stringify({ t: 'resign' })))
    const a = await verifyDuelResult(r.proofs[1].at(-1), TEST_SECRET)
    expect(a!.winner).toBe(1)
    expect(first.resigned).toBe(0)
    for (const s of [0, 1] as const) { r.clock.t += 200; r.take(await r.msg(s, JSON.stringify({ t: 'rematch' }))) }
    expect(r.last[0].status).toBe('playing')
    r.clock.t += 2000
    r.take(await r.msg(1, JSON.stringify({ t: 'resign' })))
    const b = await verifyDuelResult(r.proofs[0].at(-1), TEST_SECRET)
    expect(b!.id).not.toBe(a!.id)
    expect(b!.winner).toBe((1 - (r.host.peek().room!.resigned as Seat)) as 0 | 1)
  })

  test('a seat that reconnects after the end, even to a rebuilt object, is sent the same proof again', async () => {
    const r = await start()
    await playOut(r)
    const before = r.proofs[0].at(-1)!
    r.live.delete(adaId.ref)
    r.wake()
    r.proofs = [[], []] as never
    const res = await r.host.connect(adaId, 'ABCDEF')
    expect(res.ok).toBe(true)
    if (res.ok) r.take(res.out)
    expect(r.proofs[0].at(-1) ?? r.proofs[1].at(-1)).toBe(before)
  })

  test('a token without a player key (minted before head-to-head) gets no proof and nothing breaks', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    await playOut(r)
    expect(r.proofs[0]).toEqual([])
    expect(r.last[0].status).toBe('over')
  })

  test('the same person in both seats (equal player key) gets no proof', async () => {
    const r = rig()
    await connect(r, hostOf(adaId, 'four'))
    await connect(r, { ...SAM, pid: PID_ADA })
    await playOut(r)
    expect(r.proofs[0]).toEqual([])
  })
})
