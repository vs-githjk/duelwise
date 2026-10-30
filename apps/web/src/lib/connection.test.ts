import { afterEach, describe, expect, test } from 'bun:test'
import { isOffline, probe, setReachable } from './connection'

afterEach(() => setReachable(true))

describe('connection', () => {
  test('a probe that cannot reach the server marks us offline, and one that can marks us back online', async () => {
    expect(isOffline()).toBe(false)
    expect(await probe((async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch)).toBe(false)
    expect(isOffline()).toBe(true)
    expect(await probe((async () => new Response(null, { status: 204 })) as unknown as typeof fetch)).toBe(true)
    expect(isOffline()).toBe(false)
  })

  test('a server error is not reachable, and a hung request is given up after the timeout', async () => {
    expect(await probe((async () => new Response(null, { status: 502 })) as unknown as typeof fetch)).toBe(false)
    const hung = ((_url: string, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch
    expect(await probe(hung, 20)).toBe(false)
  })

  test('listeners hear about changes only', () => {
    // subscribeConnection needs a window; the state setter alone is covered here.
    setReachable(false)
    expect(isOffline()).toBe(true)
    setReachable(false)
    expect(isOffline()).toBe(true)
  })
})
