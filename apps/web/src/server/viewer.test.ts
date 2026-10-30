import { describe, expect, test } from 'bun:test'
import { viewerOf } from './viewer'

const ENV = { OWNER_EMAILS: 'owner@example.com' }
const user = (email: string, emailVerified = true) => ({ id: 'u-1', name: 'Pat', email, emailVerified })

describe('viewerOf: the header Owner link', () => {
  test('is on for the verified owner only', () => {
    expect(viewerOf(user('owner@example.com'), ENV)).toEqual({ user: { id: 'u-1', name: 'Pat', email: 'owner@example.com' }, owner: true })
  })
  test('is off for a signed-in non-owner, an unverified owner email, a guest and a missing allowlist', () => {
    expect(viewerOf(user('other@example.com'), ENV).owner).toBe(false)
    expect(viewerOf(user('owner@example.com', false), ENV).owner).toBe(false)
    expect(viewerOf(null, ENV)).toEqual({ user: null, owner: false })
    expect(viewerOf(user('owner@example.com'), {}).owner).toBe(false)
  })
})
