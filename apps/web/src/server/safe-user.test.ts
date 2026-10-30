import { describe, expect, test } from 'bun:test'
import { userOrNull } from './safe-user'

describe('userOrNull', () => {
  test('falls back to null (guest) when the session lookup throws', async () => {
    const orig = console.error
    console.error = () => {}
    try {
      expect(await userOrNull(async () => { throw new Error('You are using the default secret') })).toBeNull()
    } finally {
      console.error = orig
    }
  })
  test('returns the user, and null for no session', async () => {
    expect(await userOrNull(async () => ({ id: 'u1' }))).toEqual({ id: 'u1' })
    expect(await userOrNull(async () => undefined)).toBeNull()
  })
})
