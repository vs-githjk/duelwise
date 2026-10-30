import { describe, expect, test } from 'bun:test'
import { cookieSecure, originAllowed, siteOrigin } from './origin'
import { guestCookieHeader } from './guest'

const PROD = { BETTER_AUTH_URL: 'https://duelwise.example.com/' }

describe('originAllowed (L3)', () => {
  test('a write from another origin is refused, the site itself and a missing Origin pass', () => {
    expect(originAllowed('https://evil.example', PROD)).toBe(false)
    expect(originAllowed('http://duelwise.example.com', PROD)).toBe(false)
    expect(originAllowed('https://duelwise.example.com.evil.example', PROD)).toBe(false)
    expect(originAllowed('null', PROD)).toBe(false)
    expect(originAllowed('https://duelwise.example.com', PROD)).toBe(true)
    expect(originAllowed(null, PROD)).toBe(true)
    expect(originAllowed(undefined, PROD)).toBe(true)
  })

  test('with no BETTER_AUTH_URL (local dev) nothing is compared', () => {
    expect(originAllowed('http://localhost:3200', {})).toBe(true)
    expect(originAllowed('https://anything.example', { BETTER_AUTH_URL: 'not a url' })).toBe(true)
  })

  test('siteOrigin strips the path and the trailing slash', () => {
    expect(siteOrigin(PROD)).toBe('https://duelwise.example.com')
    expect(siteOrigin({})).toBeNull()
  })
})

describe('cookieSecure (L2)', () => {
  test('follows the scheme of BETTER_AUTH_URL', () => {
    expect(cookieSecure(PROD)).toBe(true)
    expect(cookieSecure({ BETTER_AUTH_URL: 'http://localhost:3200' })).toBe(false)
    expect(cookieSecure({})).toBe(false)
  })

  test('the cookie header carries Secure only when asked', () => {
    expect(guestCookieHeader('id', cookieSecure(PROD))).toContain('; Secure')
    expect(guestCookieHeader('id', cookieSecure({}))).not.toContain('Secure')
    expect(guestCookieHeader('id', true)).toContain('HttpOnly; SameSite=Lax')
  })
})

describe('refuseCrossSite', () => {
  const post = (origin?: string) => new Request('https://duelwise.example.com/api/finish', { method: 'POST', headers: origin ? { origin } : {} })
  test('answers 403 with a JSON error for a foreign Origin and null otherwise', async () => {
    const { refuseCrossSite } = await import('./origin')
    const r = refuseCrossSite(post('https://evil.example'), PROD)!
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'cross-site request refused' })
    expect(refuseCrossSite(post('https://duelwise.example.com'), PROD)).toBeNull()
    expect(refuseCrossSite(post(), PROD)).toBeNull()
  })
})

describe('routes use the helpers (L1, L3)', () => {
  const read = (p: string) => require('node:fs').readFileSync(new URL(`../routes/${p}`, import.meta.url), 'utf8') as string
  test('both write routes refuse cross-site posts first', () => {
    for (const f of ['api/finish.ts', 'api/resign.ts']) expect(read(f)).toContain('refuseCrossSite(request)')
  })
  test('the share card fetches its assets from the site, never from the request origin', () => {
    const src = read('report-card.$id.tsx')
    expect(src).toContain('getCardPng(id, link, site)')
    expect(src).not.toMatch(/getCardPng\([^)]*request\.url/)
  })
})
