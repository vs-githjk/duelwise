import { describe, expect, test } from 'bun:test'
import { PRODUCT } from '@duelwise/core/src/product'
import { parseArgs, runHandlerSmoke, runUrlSmoke, smokeRoutes } from './smoke'

type Call = { url: string; method: string }

/** A fetch that records every call and answers like a healthy deployment. */
function fakeFetch(calls: Call[], overrides: Record<string, Response> = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    if ((init?.headers as Record<string, string> | undefined)?.['x-dw-test'] !== '1') throw new Error(`no test marker on ${method} ${url}`)
    const path = new URL(url).pathname
    if (overrides[`${method} ${path}`]) return overrides[`${method} ${path}`]!.clone()
    if (method === 'POST' && path === '/api/finish') {
      return new Response(JSON.stringify({ error: 'unreadable record' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/auth/ok') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(`<!doctype html><title>${PRODUCT.name}</title>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }) as typeof fetch
}

describe('parseArgs', () => {
  test('no arguments means the local build', () => {
    expect(parseArgs([])).toEqual({ url: undefined, allowWrite: false })
  })
  test('--url and --allow-write', () => {
    expect(parseArgs(['--url', 'https://example.test', '--allow-write'])).toEqual({ url: 'https://example.test', allowWrite: true })
  })
  test('--url needs a value', () => {
    expect(() => parseArgs(['--url'])).toThrow(/--url/)
  })
  test('an unknown flag is refused', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/unknown/i)
  })
})

describe('smokeRoutes', () => {
  test('covers the landing page, the legal pages, and every game page, stats page and leaderboard', () => {
    const routes = smokeRoutes()
    for (const p of ['/', '/play', '/privacy', '/terms', '/settings', '/signin']) expect(routes).toContain(p)
    for (const { slug } of Object.values(PRODUCT.games)) {
      for (const p of [`/play/${slug}`, `/agents/${slug}`, `/leaderboard/${slug}`]) expect(routes).toContain(p)
    }
  })
})

describe('smokeRoutes for Glasscut', () => {
  test('lists the Glasscut play, stats and leaderboard pages by its slug, not by the internal id', () => {
    const routes = smokeRoutes()
    for (const p of ['/play/glasscut', '/agents/glasscut', '/leaderboard/glasscut']) expect(routes).toContain(p)
    expect(routes.filter((r) => /\/puck$/.test(r))).toEqual([])
  })
})

describe('runUrlSmoke', () => {
  test('url mode sends no POST without --allow-write', async () => {
    const calls: Call[] = []
    const checks = await runUrlSmoke('https://duelwise.example', { allowWrite: false, fetchFn: fakeFetch(calls) })
    expect(calls.length).toBeGreaterThan(smokeRoutes().length)
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
    expect(checks.every((c) => c.ok)).toBe(true)
    expect(checks.some((c) => /skipped/i.test(c.detail) && /allow-write/.test(c.detail))).toBe(true)
  })

  test('--allow-write adds one POST to /api/finish with junk bytes, which must be refused with 400', async () => {
    const calls: Call[] = []
    const checks = await runUrlSmoke('https://duelwise.example/', { allowWrite: true, fetchFn: fakeFetch(calls) })
    const posts = calls.filter((c) => c.method !== 'GET')
    expect(posts).toEqual([{ url: 'https://duelwise.example/api/finish', method: 'POST' }])
    expect(checks.every((c) => c.ok)).toBe(true)
  })

  test('a 500 on any route fails the run', async () => {
    const calls: Call[] = []
    const bad = fakeFetch(calls, { 'GET /terms': new Response('boom', { status: 500 }) })
    const checks = await runUrlSmoke('https://duelwise.example', { allowWrite: false, fetchFn: bad })
    const failed = checks.filter((c) => !c.ok)
    expect(failed.map((c) => c.name)).toEqual(['GET /terms'])
  })

  test('a thrown network error is a failed check, not a crash', async () => {
    const down = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    const checks = await runUrlSmoke('https://duelwise.example', { allowWrite: false, fetchFn: down })
    const real = checks.filter((c) => !/skipped/.test(c.detail))
    expect(real.length).toBeGreaterThan(0)
    expect(real.every((c) => !c.ok)).toBe(true)
    expect(checks[0]!.detail).toMatch(/ECONNREFUSED/)
  })

  test('plain http is refused for a remote host, allowed for localhost', async () => {
    await expect(runUrlSmoke('http://duelwise.example', { allowWrite: false, fetchFn: fakeFetch([]) })).rejects.toThrow(/https/)
    const checks = await runUrlSmoke('http://localhost:3200', { allowWrite: false, fetchFn: fakeFetch([]) })
    expect(checks.every((c) => c.ok)).toBe(true)
  })
})

describe('runHandlerSmoke', () => {
  test('a Four match against the real server agent goes through the real handlers and the database row is checked', async () => {
    const checks = await runHandlerSmoke()
    expect(checks.map((c) => c.name)).toEqual(['migrations apply to a temp PGlite dir', 'start a four match', 'finish it with a replayable record and the real agent check', 'database row is finished and valid'])
    expect(checks.filter((c) => !c.ok)).toEqual([])
  })
})
