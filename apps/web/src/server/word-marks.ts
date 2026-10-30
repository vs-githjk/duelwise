import { and, eq, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { feedback } from '@duelwise/core/src/games/word/feedback'
import { isAllowed } from '@duelwise/core/src/games/word/lists'
import { MAX_GUESSES, wordCore, type WordObs } from '@duelwise/core/src/games/word/core'
import { makeRng } from '@duelwise/core/src/rng'
import { chooseGuess } from '@duelwise/agents/src/word/solver'
import type { Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import { sameCaller, type Caller, type HandlerResponse } from './match-handlers'

type Db = PgDatabase<any, typeof schema>

export interface WordMarksBody {
  /** Marker row for every guess of each seat (0 absent, 1 elsewhere, 2 right spot). */
  marks: [number[][], number[][]]
  over: boolean
  /** Present only once the match is over: the seed the record replays from, and the hidden word. */
  reveal?: { seed: number; answer: string; /** The opponent's words, round by round; the page never holds them while the match is on. */ agentGuesses: string[] }
}

const err = (status: number, message: string): HandlerResponse<{ error: string }> => ({ status, body: { error: message } })

type Guesses = [string[], string[]]

/** The player's guesses so far, oldest first; the agent's words are never part of the request. */
function parseHumanGuesses(input: unknown): string[] | null {
  const g = (input as { guesses?: unknown } | null)?.guesses
  if (!Array.isArray(g) || g.length < 1 || g.length > MAX_GUESSES) return null
  for (const w of g) if (typeof w !== 'string' || w.length !== 5 || !isAllowed(w)) return null
  return g as string[]
}

const startsWith = (list: string[], prefix: string[]): boolean => prefix.every((w, i) => list[i] === w)

/** What the server has already marked for this match, kept under one key of the row's `filterFlags`. */
function storedGuesses(flags: Record<string, unknown> | null): Guesses {
  const g = (flags as { wordGuesses?: unknown } | null)?.wordGuesses
  if (Array.isArray(g) && g.length === 2 && Array.isArray(g[0]) && Array.isArray(g[1])) return [g[0] as string[], g[1] as string[]]
  return [[], []]
}

const AGENT_SEAT = 1

/** The agent's word for round `round`, from only what it may see: its own words and both seats' marker rows of earlier rounds. */
export function agentGuess(level: Level, seed: number, answer: string, known: Guesses, round: number): string {
  const rowsOf = (words: string[]) => words.slice(0, round).map((w) => Array.from(feedback(w, answer)))
  const obs: WordObs = {
    round,
    maxGuesses: MAX_GUESSES,
    guesses: known[AGENT_SEAT].slice(0, round),
    feedback: rowsOf(known[AGENT_SEAT]),
    opponent: rowsOf(known[0]),
    answer: null,
  }
  // A fresh stream per round keeps a retried request on the same word, and the seat mix matches the page agent.
  const rng = makeRng((seed ^ Math.imul(AGENT_SEAT + 1, 0x9e3779b1) ^ Math.imul(round + 1, 0x85ebca6b)) | 0)
  return wordCore.decodeAction(chooseGuess(level, obs, rng)) as string
}

/**
 * Plays a counted Word Duel match for the server. The client sends only the player's own guesses so far;
 * the server picks the opponent's word itself (the same solver package, seeded from the match seed) and
 * answers with the marker rows of both seats, and with the answer, the seed and the opponent's words only
 * once the game is over by the rules. It remembers what it marked and accepts one new round at a time on
 * top of it, so the endpoint cannot be used to probe extra words, and the client has no say in the opponent's play.
 */
export async function wordMarksHandler(db: Db, input: unknown, who: Caller): Promise<HandlerResponse<WordMarksBody | { error: string }>> {
  if (!who.userId && !who.guestId) return err(401, 'no player')
  const matchId = (input as { matchId?: unknown } | null)?.matchId
  if (typeof matchId !== 'string') return err(400, 'expected { matchId, guesses }')
  const mine = parseHumanGuesses(input)
  if (!mine) return err(400, 'guesses must be one to six allowed five-letter words')

  const row = (await db.select().from(schema.match).where(eq(schema.match.id, matchId)).limit(1))[0]
  if (!row) return err(404, 'unknown match')
  if (!sameCaller(row, who)) return err(403, 'not your match')
  if (row.game !== 'word') return err(400, 'not a Word Duel match')
  if (row.status !== 'started') return err(409, `match is already ${row.status}`)

  const known = storedGuesses(row.filterFlags)
  const answer = wordCore.init(row.seed).answer
  const rounds = mine.length
  const finished = known[0].length > 0 && wordCore.terminal({ answer, guesses: known })
  if (!startsWith(mine, known[0]) || rounds > known[0].length + 1 || (finished && rounds > known[0].length)) return err(409, 'guesses must continue the rounds already marked, one at a time')
  let guesses: Guesses = [mine, known[1].slice(0, rounds)]
  if (rounds > known[0].length) {
    const next: Guesses = [mine, [...known[1], agentGuess(row.level as Level, row.seed, answer, known, known[0].length)]]
    // Compare-and-set: the write only lands if the stored round count is still the one this request read,
    // so parallel requests cannot each mark a different word for the same round.
    const stored = await db
      .update(schema.match)
      .set({ filterFlags: { ...(row.filterFlags ?? {}), wordGuesses: next } })
      .where(
        and(
          eq(schema.match.id, row.id),
          eq(schema.match.status, 'started'),
          sql`coalesce(jsonb_array_length(${schema.match.filterFlags}->'wordGuesses'->0), 0) = ${known[0].length}`,
        ),
      )
      .returning({ id: schema.match.id })
    if (stored.length === 0) return err(409, 'another request marked this round first')
    guesses = next
  }

  const marks = guesses.map((list) => list.map((w) => Array.from(feedback(w, answer)))) as [number[][], number[][]]
  const over = wordCore.terminal({ answer, guesses })
  return { status: 200, body: over ? { marks, over, reveal: { seed: row.seed, answer, agentGuesses: guesses[1] } } : { marks, over } }
}
