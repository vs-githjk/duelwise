import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { feedback } from '@duelwise/core/src/games/word/feedback'
import { wordCore } from '@duelwise/core/src/games/word/core'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { startMatchHandler } from './match-handlers'
import { finishUnchecked as finishMatchHandler } from './finish-unchecked'
import { getGameStats } from './stats'
import { wordMarksHandler, type WordMarksBody } from './word-marks'

type Db = PgliteDatabase<typeof schema>
let client: PGlite
let db: Db

beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
beforeEach(async () => {
  await db.execute(sql`truncate table match, guest, rating, profile`)
  await db.insert(schema.guest).values({ id: 'g-1' }).onConflictDoNothing()
  await db.insert(schema.guest).values({ id: 'g-2' }).onConflictDoNothing()
})

const ME = { guestId: 'g-1' }
const SEED = 12345
const ANSWER = wordCore.init(SEED).answer
const WRONG = ['crane', 'slate', 'house', 'pilot', 'mound', 'fjord'].filter((w) => w !== ANSWER)

async function startWord(seed = SEED) {
  const r = await startMatchHandler(db, { game: 'word', level: 'easy' }, ME, { agentVersion: () => 'v1', seed: () => seed })
  expect(r.status).toBe(200)
  return r.body as { matchId: string; seed: number; sealed?: boolean }
}

const ask = (matchId: string, guesses: string[], who = ME) => wordMarksHandler(db, { matchId, guesses }, who)

/** The opponent's words as the server stored them. */
async function storedAgentWords(matchId: string): Promise<string[]> {
  const row = (await db.select().from(schema.match).where(eq(schema.match.id, matchId)))[0]!
  return (row.filterFlags as { wordGuesses: [string[], string[]] }).wordGuesses[1]
}

describe('the answer stays on the server in a counted Word Duel match', () => {
  test('start hides the seed (so the answer cannot be worked out in the browser) and says so', async () => {
    const m = await startWord()
    expect(m.sealed).toBe(true)
    expect(m.seed).toBe(0)
    expect(JSON.stringify(m)).not.toContain(String(SEED))
    // The row still holds the real seed, which the server replays the finished record from.
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
    expect(row.seed).toBe(SEED)
  })

  test('other games still get their seed', async () => {
    const r = await startMatchHandler(db, { game: 'four', level: 'easy' }, ME, { agentVersion: () => 'v1', seed: () => SEED })
    expect(r.body).toMatchObject({ seed: SEED })
    expect((r.body as { sealed?: boolean }).sealed).toBeUndefined()
  })

  test('a guess round comes back as markers only, with no answer, no seed and no opponent word', async () => {
    const m = await startWord()
    const r = await ask(m.matchId, [WRONG[0]!])
    expect(r.status).toBe(200)
    const body = r.body as WordMarksBody
    const theirs = (await storedAgentWords(m.matchId))[0]!
    expect(body.marks[0]).toEqual([Array.from(feedback(WRONG[0]!, ANSWER))])
    expect(body.marks[1]).toEqual([Array.from(feedback(theirs, ANSWER))])
    expect(body.over).toBe(false)
    expect(body.reveal).toBeUndefined()
    const text = JSON.stringify(body)
    expect(text).not.toContain(ANSWER)
    expect(text).not.toContain(theirs)
    expect(text).not.toContain(String(SEED))
  })

  test('the answer, the seed and the opponent words are revealed only once the match is over', async () => {
    const m = await startWord()
    const mine: string[] = []
    for (let i = 0; i < 5; i++) {
      mine.push(WRONG[i]!)
      const r = (await ask(m.matchId, [...mine])).body as WordMarksBody
      // The opponent is a real solver: it may solve first, which ends the match for everyone.
      if (r.over) return
      expect(r.reveal).toBeUndefined()
      expect(JSON.stringify(r)).not.toContain(ANSWER)
    }
    mine.push(ANSWER)
    const last = (await ask(m.matchId, mine)).body as WordMarksBody
    expect(last.over).toBe(true)
    expect(last.reveal).toMatchObject({ seed: SEED, answer: ANSWER })
    expect(last.reveal!.agentGuesses).toEqual(await storedAgentWords(m.matchId))
  })

  test('nothing more is marked after the game is over', async () => {
    const m = await startWord()
    expect((await ask(m.matchId, [ANSWER])).body).toMatchObject({ over: true })
    expect((await ask(m.matchId, [ANSWER, WRONG[1]!])).status).toBe(409)
  })

  test('only one new round at a time, building on what the server already marked', async () => {
    const m = await startWord()
    expect((await ask(m.matchId, [WRONG[0]!])).status).toBe(200)
    // Two rounds at once would let a client probe extra words.
    expect((await ask(m.matchId, [WRONG[0]!, WRONG[2]!, WRONG[3]!])).status).toBe(409)
    // Swapping an earlier word for a probe is refused too.
    expect((await ask(m.matchId, [WRONG[4]!, WRONG[2]!])).status).toBe(409)
    // Asking again with the same rounds is harmless (a retry), and the opponent keeps the same word.
    const before = await storedAgentWords(m.matchId)
    expect((await ask(m.matchId, [WRONG[0]!])).status).toBe(200)
    expect(await storedAgentWords(m.matchId)).toEqual(before)
    expect((await ask(m.matchId, [WRONG[0]!, WRONG[2]!])).status).toBe(200)
  })

  test('a scripted client cannot supply, swap or slow the opponent: extra fields are ignored and the opponent plays from the seed', async () => {
    const a = await startWord()
    const b = await startWord()
    // A request that carries opponent words of its own (the old shape) gets the same play as one that does not.
    const forged = await wordMarksHandler(db, { matchId: a.matchId, guesses: [WRONG[0]!], opponent: [ANSWER], agentGuesses: [ANSWER] }, ME)
    await ask(b.matchId, [WRONG[0]!])
    expect((forged.body as WordMarksBody).over).toBe(false)
    expect(await storedAgentWords(a.matchId)).toEqual(await storedAgentWords(b.matchId))
    // The old two-list body is refused outright.
    expect((await wordMarksHandler(db, { matchId: a.matchId, guesses: [[WRONG[0]!], [ANSWER]] }, ME)).status).toBe(400)
  })

  test('the opponent plays only from marker rows: its word depends on the seed and rounds, never on the player current word', async () => {
    const a = await startWord()
    const b = await startWord()
    await ask(a.matchId, [WRONG[0]!])
    await ask(b.matchId, [WRONG[1]!])
    expect((await storedAgentWords(a.matchId))[0]).toBe((await storedAgentWords(b.matchId))[0])
  })

  test('refuses other players, other games, finished matches and bad input', async () => {
    const m = await startWord()
    expect((await ask(m.matchId, [WRONG[0]!], { guestId: 'g-2' })).status).toBe(403)
    expect((await ask('nope', [WRONG[0]!])).status).toBe(404)
    expect((await wordMarksHandler(db, { matchId: m.matchId, guesses: ['abc'] }, ME)).status).toBe(400)
    expect((await wordMarksHandler(db, { matchId: m.matchId, guesses: ['zzzzz'] }, ME)).status).toBe(400)
    expect((await wordMarksHandler(db, { matchId: m.matchId, guesses: [] }, ME)).status).toBe(400)
    expect((await wordMarksHandler(db, { matchId: m.matchId }, ME)).status).toBe(400)
    expect((await wordMarksHandler(db, { matchId: m.matchId, guesses: [WRONG[0]!] }, {})).status).toBe(401)
    const four = await startMatchHandler(db, { game: 'four', level: 'easy' }, ME)
    expect((await ask((four.body as { matchId: string }).matchId, [WRONG[0]!])).status).toBe(400)
    await db.update(schema.match).set({ status: 'finished' }).where(eq(schema.match.id, m.matchId))
    expect((await ask(m.matchId, [WRONG[0]!])).status).toBe(409)
  })

  test('every level picks its words on the server, one word per round, none of them the hidden word before it is earned', async () => {
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
      const r = await startMatchHandler(db, { game: 'word', level }, ME, { agentVersion: () => 'v1', seed: () => SEED })
      const id = (r.body as { matchId: string }).matchId
      const mine: string[] = []
      for (let i = 0; i < 3; i++) {
        mine.push(WRONG[i]!)
        const reply = await ask(id, [...mine])
        expect(reply.status).toBe(200)
        if ((reply.body as WordMarksBody).over) break
      }
      const words = await storedAgentWords(id)
      expect(words.length).toBeGreaterThan(0)
      for (const w of words) expect(w).toHaveLength(5)
    }
  })
})


function wordRecord(matchId: string, seed: number, guesses: [string[], string[]]): Uint8Array {
  let st = wordCore.init(seed)
  const actions: [number, 0 | 1, number][] = []
  for (let t = 0; t < guesses[0].length; t++) {
    actions.push([t, 0, wordCore.encodeAction(guesses[0][t]!)], [t, 1, wordCore.encodeAction(guesses[1][t]!)])
    st = wordCore.step(st, [guesses[0][t]!, guesses[1][t]!])
  }
  const rec: MatchRecordV1 = {
    schema: 1, matchId, game: 'word', coreVersion: wordCore.version, agent: { version: 'v1', level: 'easy' }, seed, humanSeat: 0, actions,
    result: wordCore.result(st)!, finalHash: wordCore.hash(st), trainingAllowed: false,
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), device: 'desktop', input: 'keyboard',
  }
  return encodeRecord(rec)
}

describe('the sealed match cannot be finished with a forged record', () => {
  test('a one-guess win uploaded after six junk rounds is invalid', async () => {
    const m = await startWord()
    const mine: string[] = []
    let last: WordMarksBody | undefined
    for (let i = 0; i < 6 && !last?.over; i++) {
      mine.push(WRONG[i]!)
      last = (await ask(m.matchId, [...mine])).body as WordMarksBody
    }
    expect(last!.over).toBe(true)
    const seed = last!.reveal!.seed
    const forged = await finishMatchHandler(db, wordRecord(m.matchId, seed, [[ANSWER], [last!.reveal!.agentGuesses[0]!]]), ME)
    expect(forged.body).toMatchObject({ valid: false, reason: 'record does not match the marked rounds' })
  })

  test('a record uploaded before the match reached its end is invalid', async () => {
    const m = await startWord()
    await ask(m.matchId, [WRONG[0]!])
    const early = await finishMatchHandler(db, wordRecord(m.matchId, SEED, [[ANSWER], [(await storedAgentWords(m.matchId))[0]!]]), ME)
    expect(early.body).toMatchObject({ valid: false })
  })

  test('the honest record of the marked rounds is valid', async () => {
    const m = await startWord()
    await ask(m.matchId, [WRONG[0]!])
    const done = (await ask(m.matchId, [WRONG[0]!, ANSWER])).body as WordMarksBody
    expect(done.over).toBe(true)
    const ok = await finishMatchHandler(db, wordRecord(m.matchId, SEED, [[WRONG[0]!, ANSWER], done.reveal!.agentGuesses]), ME)
    expect(ok.body).toMatchObject({ valid: true })
  })

  test('a guess-only word is marked like any guess and its record is valid; a still-blocked word is refused', async () => {
    const m = await startWord()
    expect((await ask(m.matchId, ['dicky'])).status).toBe(400)
    expect((await ask(m.matchId, ['pussy'])).status).toBe(400)
    const first = await ask(m.matchId, ['prick'])
    expect(first.status).toBe(200)
    expect((first.body as WordMarksBody).marks[0]).toEqual([Array.from(feedback('prick', ANSWER))])
    const done = (await ask(m.matchId, ['prick', ANSWER])).body as WordMarksBody
    expect(done.over).toBe(true)
    const ok = await finishMatchHandler(db, wordRecord(m.matchId, SEED, [['prick', ANSWER], done.reveal!.agentGuesses]), ME)
    expect(ok.body).toMatchObject({ valid: true })
  })

  test('a finished, sealed match is counted by the stats funnel with no filter reason', async () => {
    const m = await startWord()
    await ask(m.matchId, [ANSWER])
    expect((await finishMatchHandler(db, wordRecord(m.matchId, SEED, [[ANSWER], await storedAgentWords(m.matchId)]), ME)).body).toMatchObject({ valid: true })
    const f = (await getGameStats(db, 'word')).funnel
    expect(f.finished).toBe(1)
    expect(f.passedFilters).toBe(1)
    expect(f.reasons).toEqual({})
  })
})

describe('parallel requests', () => {
  test('ten requests marking different words for round one: exactly one is accepted', async () => {
    const m = await startWord()
    const words = ['crane', 'slate', 'house', 'pilot', 'mound', 'fjord', 'brick', 'gusty', 'nymph', 'waltz'].filter((w) => w !== ANSWER)
    const rs = await Promise.all(words.map((w) => ask(m.matchId, [w])))
    expect(rs.filter((r) => r.status === 200).length).toBe(1)
    expect(rs.filter((r) => r.status === 409).length).toBe(words.length - 1)
  })
})
