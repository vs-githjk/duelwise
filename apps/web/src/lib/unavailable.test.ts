import { expect, test } from 'bun:test'
import { orUnavailable } from './unavailable'

test('a failed load becomes the unavailable marker, a good one passes through', async () => {
  expect(await orUnavailable(async () => { throw new Error('Something went wrong') }, () => false)).toEqual({ unavailable: true })
  expect(await orUnavailable(async () => ({ rows: [] }), () => false)).toEqual({ rows: [] })
})

test('an offline failure still throws so the offline screen shows', async () => {
  const offline = new TypeError('Failed to fetch')
  await expect(orUnavailable(async () => { throw offline }, (e) => e === offline)).rejects.toBe(offline)
})
