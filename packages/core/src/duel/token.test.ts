import { describe, expect, test } from 'bun:test'
import { signDuelToken, verifyDuelToken } from './token'

const SECRET = 'test-secret-test-secret-0123456789'
const NOW = 1_800_000_000_000
const p = { code: 'ABCDEF', ref: 'h4sh3d', name: 'Ada', exp: NOW + 60_000 }

describe('duel token', () => {
  test('round trip: guest and host tokens', async () => {
    expect(await verifyDuelToken(await signDuelToken(p, SECRET), SECRET, NOW)).toEqual({ code: 'ABCDEF', ref: 'h4sh3d', name: 'Ada', exp: p.exp, host: null })
    const h = await verifyDuelToken(await signDuelToken({ ...p, host: { game: 'four' } }, SECRET), SECRET, NOW)
    expect(h?.host).toEqual({ game: 'four' })
  })

  test('tampered, re-signed with another secret, truncated, expired and hostile tokens all give null and never throw', async () => {
    const t = await signDuelToken(p, SECRET)
    const [body, sig] = t.split('.') as [string, string]
    const forgedBody = btoa(JSON.stringify({ v: 1, c: 'ABCDEF', r: 'someone-else', n: 'Ada', e: p.exp })).replace(/=+$/, '')
    const bad = [
      `${forgedBody}.${sig}`,
      `${body}.${sig.slice(0, -3)}AAA`,
      await signDuelToken(p, 'another-secret-another-secret'),
      t.slice(0, 20),
      '', '.', 'a.b.c', '%%%.%%%', 'x'.repeat(5000),
    ]
    for (const x of bad) expect(await verifyDuelToken(x, SECRET, NOW)).toBeNull()
    expect(await verifyDuelToken(t, SECRET, p.exp)).toBeNull() // exp is exclusive
    expect(await verifyDuelToken(t, SECRET, p.exp + 1)).toBeNull()
    expect(await verifyDuelToken(t, SECRET, p.exp - 1)).not.toBeNull()
  })

  test('the payload holds only code, ref, name, expiry (and the host game): no email, no user id', async () => {
    const t = await signDuelToken({ ...p, host: { game: 'word' } }, SECRET)
    const json = JSON.parse(atob(t.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (t.split('.')[0]!.length % 4)) % 4)))
    expect(Object.keys(json).sort()).toEqual(['c', 'e', 'h', 'n', 'r', 'v'])
  })

  test('a missing or short secret and a bad code are refused loudly at signing, not silently accepted', async () => {
    await expect(signDuelToken(p, '')).rejects.toThrow()
    await expect(signDuelToken(p, 'short')).rejects.toThrow()
    await expect(signDuelToken({ ...p, code: 'abc' }, SECRET)).rejects.toThrow()
    await expect(verifyDuelToken(await signDuelToken(p, SECRET), '', NOW)).rejects.toThrow()
  })
})
