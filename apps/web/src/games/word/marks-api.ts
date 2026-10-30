import type { WordMarksBody } from '../../server/word-marks'

/** Sends my guesses of a counted match; the server plays the opponent and returns both seats' marker rows. The hidden word is only returned at the end. */
export type FetchMarks = (matchId: string, guesses: string[]) => Promise<WordMarksBody>

/** The real call: the server function, loaded on first use so this file stays free of server code. */
export const serverFetchMarks: FetchMarks = async (matchId, guesses) => {
  const { wordMarks } = await import('../../server/word-marks-fns')
  const r = (await wordMarks({ data: { matchId, guesses } })) as WordMarksBody | { error: string }
  if ('error' in r) throw new Error(r.error)
  return r
}
