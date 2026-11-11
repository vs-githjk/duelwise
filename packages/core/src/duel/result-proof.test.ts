import { describe, expect, test } from 'bun:test'
import { signDuelResult, verifyDuelResult, type DuelResultRecord } from './result-proof'
import { signDuelToken, verifyDuelToken } from './token'

const SECRET = 'test-secret-test-secret-0123456789'
const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const rec: DuelResultRecord = {
  id: 'ABCDEF.1700000000000.1',
  game: 'four',
  at: 1_700_000_100_000,
  players: [{ ref: 'ref-ada', pid: A, name: 'Ada', rating: 1240 }, { ref: 'ref-sam', pid: B, name: 'Sam' }],
  winner: 0,
}

describe('duel result proof', () => {
  test('round trip keeps every field', async () => {
    expect(await verifyDuelResult(await signDuelResult(rec, SECRET), SECRET)).toEqual(rec)
    expect(await verifyDuelResult(await signDuelResult({ ...rec, winner: null }, SECRET), SECRET)).toEqual({ ...rec, winner: null })
  })

  test('a changed winner, name or player, another secret, truncation and hostile input all give null and never throw', async () => {
    const t = await signDuelResult(rec, SECRET)
    const [body, sig] = t.split('.') as [string, string]
    const forged = (patch: object) => btoa(JSON.stringify({ v: 1, k: 'result', ...rec, ...patch })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
    const bad = [`${forged({ winner: 1 })}.${sig}`, `${forged({ id: 'ABCDEF.1700000000000.2' })}.${sig}`, `${body}.${sig.slice(0, -3)}AAA`, await signDuelResult(rec, 'another-secret-another-secret'), t.slice(0, 30), '', '.', 'a.b.c', '%%%.%%%', 'x'.repeat(5000)]
    for (const x of bad) expect(await verifyDuelResult(x, SECRET)).toBeNull()
    expect(await verifyDuelResult(undefined, SECRET)).toBeNull()
    expect(await verifyDuelResult({}, SECRET)).toBeNull()
  })

  test('a room token can never pass for a result, even with the right secret', async () => {
    const tok = await signDuelToken({ code: 'ABCDEF', ref: 'r', name: 'Ada', exp: Date.now() + 60_000, pid: A }, SECRET)
    expect(await verifyDuelResult(tok, SECRET)).toBeNull()
    expect(await verifyDuelToken(await signDuelResult(rec, SECRET), SECRET, 0)).toBeNull()
  })

  test('well signed but malformed records are refused: same player twice, a bad pid, a bad winner', async () => {
    for (const bad of [
      { ...rec, players: [rec.players[0], { ...rec.players[1], pid: A }] },
      { ...rec, players: [{ ...rec.players[0], pid: 'not-hex' }, rec.players[1]] },
      { ...rec, winner: 2 },
      { ...rec, id: 'x' },
    ]) expect(await verifyDuelResult(await signDuelResult(bad as never, SECRET), SECRET)).toBeNull()
  })
})

describe('token pid and ratings', () => {
  const p = { code: 'ABCDEF', ref: 'r', name: 'Ada', exp: 1_800_000_060_000 }
  test('pid and ratings round trip; junk ratings are dropped, a bad pid is ignored', async () => {
    const v = await verifyDuelToken(await signDuelToken({ ...p, pid: A, rt: { chess: 1240, four: 980 } }, SECRET), SECRET, 1_800_000_000_000)
    expect(v?.pid).toBe(A)
    expect(v?.rt).toEqual({ chess: 1240, four: 980 })
    const junk = await verifyDuelToken(await signDuelToken({ ...p, pid: 'zz', rt: { chess: 1.5, 'BAD KEY': 3, four: 99999 } as never }, SECRET), SECRET, 1_800_000_000_000)
    expect(junk?.pid).toBeUndefined()
    expect(junk?.rt).toBeUndefined()
  })
  test('the token still holds no email and no user id: pid is a 32 hex hash', async () => {
    const t = await signDuelToken({ ...p, pid: A }, SECRET)
    const b = t.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')
    const raw = atob(b + '='.repeat((4 - (b.length % 4)) % 4))
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['c', 'e', 'n', 'p', 'r', 'v'])
  })
})
