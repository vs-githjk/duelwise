import { expect, test } from 'bun:test'
import { notFound, redirect } from '@tanstack/react-router'
import { GENERIC_ERROR, guardServerError, sanitizeServerError } from './safe-errors'

/** What drizzle throws when the Neon HTTP driver answers 402: the SQL and its bound params ride in the message. */
function drizzleError() {
  const cause = Object.assign(new Error('Your project has exceeded the data transfer quota'), { name: 'NeonDbError', code: '402' })
  return Object.assign(new Error('Failed query: select "id", "email" from "user" where "user"."email" = $1\nparams: owner@example.com'), { name: 'DrizzleQueryError', query: 'select "id", "email" from "user"', params: ['owner@example.com'], cause })
}

const LEAKS = [/Failed query/i, /select/i, /params/i, /owner@example\.com/, /quota/i, /neon/i]

test('a database error reaches the client as one generic message and the details stay in the server log', async () => {
  const logged: unknown[][] = []
  const real = console.error
  console.error = (...a: unknown[]) => void logged.push(a)
  try {
    const err = await guardServerError(async () => { throw drizzleError() }).catch((e) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe(GENERIC_ERROR)
    expect(GENERIC_ERROR).toBe('Something went wrong')
    const wire = JSON.stringify({ message: err.message, name: err.name, stack: err.stack, cause: (err as { cause?: unknown }).cause, own: Object.entries(err) })
    for (const re of LEAKS) expect(wire).not.toMatch(re)
    expect(JSON.stringify(logged.map((a) => a.map(String)))).toContain('owner@example.com')
  } finally {
    console.error = real
  }
})

test('redirects, not-found and Response objects pass through untouched', async () => {
  const r = redirect({ to: '/signin' })
  const nf = notFound()
  const res = new Response('x', { status: 401 })
  for (const thrown of [r, nf, res]) {
    const got = await guardServerError(async () => { throw thrown }).catch((e) => e)
    expect(got).toBe(thrown)
  }
  expect(sanitizeServerError(r)).toBe(r)
})

test('a value that succeeds is returned as is', async () => {
  expect(await guardServerError(async () => 42)).toBe(42)
})
