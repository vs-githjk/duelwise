import { expect, test } from 'bun:test'
import { cachedFor } from './ttl-cache'

test('concurrent cold loads share one in-flight load', async () => {
  const db = {}
  let calls = 0
  const load = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 10))
    return 'v'
  }
  const out = await Promise.all([1, 2, 3, 4].map(() => cachedFor(db, 'k', 1000, 60_000, load)))
  expect(out).toEqual(['v', 'v', 'v', 'v'])
  expect(calls).toBe(1)
})

test('a failed load is not cached and the next call retries', async () => {
  const db = {}
  let calls = 0
  await expect(cachedFor(db, 'k', 1000, 60_000, async () => { calls++; throw new Error('x') })).rejects.toThrow('x')
  expect(await cachedFor(db, 'k', 1001, 60_000, async () => { calls++; return 7 })).toBe(7)
  expect(calls).toBe(2)
})
