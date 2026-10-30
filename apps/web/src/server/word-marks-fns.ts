import { createServerFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import { callerFromRequest } from './caller'
import { getServerDb } from './server-db'
import { wordMarksHandler } from './word-marks'

/** Marks the guesses of a counted Word Duel match; the hidden word never leaves the server before the end. */
export const wordMarks = createServerFn({ method: 'POST' })
  .validator((d: unknown) => d)
  .handler(async ({ data }) => {
    const { db } = await getServerDb()
    const who = await callerFromRequest()
    const r = await wordMarksHandler(db, data, who)
    setResponseStatus(r.status)
    return r.body
  })
