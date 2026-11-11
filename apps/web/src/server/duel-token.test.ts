import { describe, expect, test } from 'bun:test'
import { signDuelToken, verifyDuelToken, ROOM_CODE } from '@duelwise/core/src/duel/token'
import { createChallenge, joinChallenge, newRoomCode, callerRef, TOKEN_TTL_MS, type ChallengeDeps } from './duel-token'

const SECRET = 'test-secret-at-least-16-chars-long'
const NOW = 1_800_000_000_000
const DEVICE = '3f2b1c9e-7a44-4d0e-9a51-0c6f2f0b1a11'

function deps(over: Partial<ChallengeDeps> = {}, log: string[] = []): ChallengeDeps {
  return {
    secret: SECRET,
    now: () => NOW,
    code: () => 'ABCDEF',
    viewer: async () => {
      log.push('viewer')
      return {}
    },
    savedName: async () => {
      log.push('savedName')
      return null
    },
    ratings: async () => ({}),
    ...over,
  }
}

describe('room codes', () => {
  test('are six characters of A-Z and 2-7, and differ', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const c = newRoomCode()
      expect(ROOM_CODE.test(c)).toBe(true)
      seen.add(c)
    }
    expect(seen.size).toBeGreaterThan(190)
  })
})

describe('token round trip', () => {
  test('a minted host token verifies and carries the room, game and name only', async () => {
    const r = await createChallenge(deps(), { game: 'chess', name: 'Ada', deviceId: DEVICE })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.code).toBe('ABCDEF')
    expect(r.exp).toBe(NOW + TOKEN_TTL_MS)
    const v = await verifyDuelToken(r.token, SECRET, NOW)
    expect(v).toMatchObject({ code: 'ABCDEF', name: 'Ada', host: { game: 'chess' } })
    expect(v!.ref).toMatch(/^[0-9a-f]{32}$/)
  })

  test('a guest token has no host block', async () => {
    const r = await joinChallenge(deps(), { code: 'ABCDEF', name: 'Sam', deviceId: DEVICE })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((await verifyDuelToken(r.token, SECRET, NOW))!.host).toBeNull()
  })

  test('tampered, wrong-secret and expired tokens fail', async () => {
    const r = await createChallenge(deps(), { game: 'four', name: 'Ada', deviceId: DEVICE })
    if (!r.ok) throw new Error('mint failed')
    const [body, sig] = r.token.split('.')
    const forged = `${Buffer.from(JSON.stringify({ v: 1, c: 'ABCDEF', r: 'x', n: 'Mallory', e: NOW + 1e9 })).toString('base64url')}.${sig}`
    expect(await verifyDuelToken(forged, SECRET, NOW)).toBeNull()
    expect(await verifyDuelToken(`${body}.${sig!.slice(0, -2)}AA`, SECRET, NOW)).toBeNull()
    expect(await verifyDuelToken(r.token, 'another-secret-also-16-chars', NOW)).toBeNull()
    expect(await verifyDuelToken(r.token, SECRET, NOW + TOKEN_TTL_MS + 1)).toBeNull()
    const direct = await signDuelToken({ code: 'ABCDEF', ref: 'r', name: 'n', exp: NOW - 1 }, SECRET)
    expect(await verifyDuelToken(direct, SECRET, NOW)).toBeNull()
  })

  test('the token holds no email and no user or guest id, only a hashed reference', async () => {
    const log: string[] = []
    const r = await createChallenge(
      deps({ viewer: async () => ({ userId: 'user-1234-secret', guestId: 'guest-9999-secret' }) }, log),
      { game: 'word', name: 'Ada', deviceId: DEVICE },
    )
    if (!r.ok) throw new Error('mint failed')
    const payload = Buffer.from(r.token.split('.')[0]!, 'base64url').toString('utf8')
    for (const leak of ['user-1234-secret', 'guest-9999-secret', DEVICE, '@']) expect(payload.includes(leak)).toBe(false)
  })
})

describe('caller reference', () => {
  test('is stable for one person on one device and differs by device and by account', async () => {
    const a = await callerRef(SECRET, {}, DEVICE)
    expect(await callerRef(SECRET, {}, DEVICE)).toBe(a)
    expect(await callerRef(SECRET, {}, '11111111-2222-4333-8444-555555555555')).not.toBe(a)
    expect(await callerRef(SECRET, { userId: 'u1' }, DEVICE)).not.toBe(a)
    expect(await callerRef('different-secret-16-chars', {}, DEVICE)).not.toBe(a)
  })

  test('the same account on two devices gets two seats, so a host and a guest never collide', async () => {
    const h = await createChallenge(deps({ viewer: async () => ({ userId: 'u1' }) }), { game: 'chess', name: 'Ada', deviceId: DEVICE })
    const g = await joinChallenge(deps({ viewer: async () => ({ userId: 'u1' }) }), { code: 'ABCDEF', name: 'Ada', deviceId: '11111111-2222-4333-8444-555555555555' })
    if (!h.ok || !g.ok) throw new Error('mint failed')
    const [hv, gv] = [await verifyDuelToken(h.token, SECRET, NOW), await verifyDuelToken(g.token, SECRET, NOW)]
    expect(hv!.ref).not.toBe(gv!.ref)
  })
})

describe('refusals and names', () => {
  test('no secret means links are not switched on', async () => {
    expect(await createChallenge(deps({ secret: undefined }), { game: 'chess', name: 'Ada', deviceId: DEVICE })).toEqual({ ok: false, error: 'unavailable' })
    expect(await joinChallenge(deps({ secret: '' }), { code: 'ABCDEF', name: 'Ada', deviceId: DEVICE })).toEqual({ ok: false, error: 'unavailable' })
  })

  test('only the six relay games, a good code, a device id', async () => {
    expect(await createChallenge(deps(), { game: 'holdem', name: 'Ada', deviceId: DEVICE })).toEqual({ ok: false, error: 'bad-game' })
    expect(await createChallenge(deps(), { game: 'nope', name: 'Ada', deviceId: DEVICE })).toEqual({ ok: false, error: 'bad-game' })
    expect(await joinChallenge(deps(), { code: 'abc', name: 'Ada', deviceId: DEVICE })).toEqual({ ok: false, error: 'bad-code' })
    expect(await createChallenge(deps(), { game: 'chess', name: 'Ada', deviceId: 'short' })).toEqual({ ok: false, error: 'no-device' })
  })

  test('the name goes through the board filter; blank falls back to the saved name, then to a plain label', async () => {
    const bad = await createChallenge(deps(), { game: 'chess', name: 'xXfuckXx', deviceId: DEVICE })
    expect(bad.ok).toBe(false)
    const saved = await createChallenge(deps({ savedName: async () => 'Nova' }), { game: 'chess', name: '  ', deviceId: DEVICE })
    if (!saved.ok) throw new Error('mint failed')
    expect(saved.name).toBe('Nova')
    const none = await joinChallenge(deps(), { code: 'ABCDEF', name: '', deviceId: DEVICE })
    if (!none.ok) throw new Error('mint failed')
    expect(none.name).toBe('Player 2')
  })

  test('minting only reads (viewer, saved name) and never writes: the deps expose no write', async () => {
    const log: string[] = []
    await createChallenge(deps({}, log), { game: 'chess', name: '', deviceId: DEVICE })
    await joinChallenge(deps({}, log), { code: 'ABCDEF', name: '', deviceId: DEVICE })
    expect(log.every((l) => l === 'viewer' || l === 'savedName')).toBe(true)
    expect(Object.keys(deps()).sort()).toEqual(['code', 'now', 'ratings', 'savedName', 'secret', 'viewer'])
  })

  test('the token carries a player key (never the user id) and, for a signed-in person, only the public ratings they have', async () => {
    const signedIn = deps({ viewer: async () => ({ userId: 'user-1234-secret' }), ratings: async () => ({ chess: 1240 }) })
    const a = await createChallenge(signedIn, { game: 'chess', name: 'Ada', deviceId: DEVICE })
    if (!a.ok) throw new Error('mint failed')
    const va = await verifyDuelToken(a.token, SECRET, NOW)
    expect(va!.pid).toMatch(/^[0-9a-f]{32}$/)
    expect(va!.rt).toEqual({ chess: 1240 })
    expect(a.token.includes('user-1234')).toBe(false)
    // the same account on another phone has the same player key but another ref
    const other = await joinChallenge(signedIn, { code: 'ABCDEF', name: 'Ada', deviceId: '9f2b1c9e-7a44-4d0e-9a51-0c6f2f0b1a99' })
    if (!other.ok) throw new Error('mint failed')
    const vo = await verifyDuelToken(other.token, SECRET, NOW)
    expect(vo!.pid).toBe(va!.pid)
    expect(vo!.ref).not.toBe(va!.ref)
    // signed out: the key follows the browser, no ratings are read
    const log: string[] = []
    const guest = await joinChallenge(deps({ ratings: async () => { log.push('ratings'); return { chess: 1 } } }), { code: 'ABCDEF', name: 'Sam', deviceId: DEVICE })
    if (!guest.ok) throw new Error('mint failed')
    const vg = await verifyDuelToken(guest.token, SECRET, NOW)
    expect(vg!.pid).toMatch(/^[0-9a-f]{32}$/)
    expect(vg!.pid).not.toBe(va!.pid)
    expect(vg!.rt).toBeUndefined()
    expect(log).toEqual([])
  })

  test('a failing ratings read does not stop a challenge', async () => {
    const r = await joinChallenge(deps({ viewer: async () => ({ userId: 'u1' }), ratings: async () => { throw new Error('db down') } }), { code: 'ABCDEF', name: 'Ada', deviceId: DEVICE })
    expect(r.ok).toBe(true)
  })
})
