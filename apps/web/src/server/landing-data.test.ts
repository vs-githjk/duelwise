import { expect, test } from 'bun:test'
import { databaseParts } from './landing-data'

/** A db whose every query fails the way Neon does once the plan's transfer quota is gone. */
const quota = () => new Error('Failed query: select "id" from "match" params: owner@example.com')
const downDb = new Proxy({}, { get: () => () => { throw quota() } }) as never

test('landing database parts fall back to empty when every query throws', async () => {
  const quiet = console.error
  console.error = () => {}
  try {
    const parts = await databaseParts(async () => ({ db: downDb }) as never)
    expect(parts.board).toEqual({ matches: 0, humanWins: 0, perGame: [], latest: [] })
    expect(parts.records).toEqual([])
  } finally {
    console.error = quiet
  }
})

test('landing database parts fall back to empty when the database cannot even be opened', async () => {
  const quiet = console.error
  console.error = () => {}
  try {
    const parts = await databaseParts(async () => { throw quota() })
    expect(parts.board.matches).toBe(0)
    expect(parts.records).toEqual([])
  } finally {
    console.error = quiet
  }
})
