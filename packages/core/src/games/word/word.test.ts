import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { replay } from '../../replay'
import { encodeRecord, decodeRecord, type MatchRecordV1 } from '../../match-record'
import { getCore } from '../index'
import { ALLOWED_TEXT, ANSWERS_TEXT, GUESS_ONLY_TEXT } from './lists.generated'
import { ALLOWED, ANSWERS, GUESS_ONLY, allowedIndex, answerIndex, isAllowed } from './lists'
import { wordCore, MAX_GUESSES } from './core'
import { feedback, patternCode } from './feedback'

const dir = join(import.meta.dir, 'lists')
const read = (f: string) => readFileSync(join(dir, f), 'utf8')
const lines = (t: string) => t.split('\n').filter(Boolean)
const fb = (g: string, a: string) => Array.from(feedback(g, a)).join('')

describe('feedback', () => {
  test('all right and all absent', () => {
    expect(fb('crane', 'crane')).toBe('22222')
    expect(fb('crane', 'sloth')).toBe('00000')
  })
  test('in the word but elsewhere', () => {
    expect(fb('crane', 'nacre')).toBe('11112')
  })
  test('a repeated guess letter gets no more markers than the answer has copies', () => {
    expect(fb('eerie', 'crane')).toBe('00102') // the right-spot e is taken first, the other e's find none left
    expect(fb('speed', 'abide')).toBe('00101') // one e in the answer: only the first guessed e is marked
    expect(fb('speed', 'erase')).toBe('10110') // two e's in the answer: both guessed e's are marked
    expect(fb('lolly', 'allow')).toBe('11200') // two l's in the answer: the right-spot one and one more
  })
  test('right-spot letters are marked before in-word ones', () => {
    expect(fb('babes', 'abbey')).toBe('11220') // b at 2 is right; b at 0 takes the other b
    expect(fb('floor', 'robot')).toBe('00121') // o at 3 is right; o at 2 takes the other o
  })
  test('pattern code is base 3 with the first letter most significant', () => {
    expect(patternCode(feedback('crane', 'crane'))).toBe(242)
    expect(patternCode(feedback('crane', 'sloth'))).toBe(0)
    expect(patternCode([1, 0, 0, 0, 0])).toBe(81)
  })
})

describe('word lists', () => {
  const answers = lines(read('answers.txt'))
  const allowed = lines(read('allowed.txt'))
  const exclude = lines(read('exclude.txt'))

  test('every word is five lowercase letters, with no duplicates', () => {
    for (const list of [answers, allowed, exclude]) {
      expect(list.every((w) => /^[a-z]{5}$/.test(w))).toBe(true)
      expect(new Set(list).size).toBe(list.length)
    }
  })
  test('answer count is 1,500 to 4,000', () => {
    expect(answers.length).toBeGreaterThanOrEqual(1500)
    expect(answers.length).toBeLessThanOrEqual(4000)
  })
  test('answers are a subset of allowed', () => {
    const set = new Set(allowed)
    expect(answers.filter((w) => !set.has(w))).toEqual([])
  })
  test('no excluded word is in either list', () => {
    const ex = new Set(exclude)
    expect(exclude.length).toBeGreaterThan(30)
    expect(answers.filter((w) => ex.has(w))).toEqual([])
    expect(allowed.filter((w) => ex.has(w))).toEqual([])
  })
  test('no answer is a plural, third-person -s or -ed form unless hand-reviewed in keep-inflected.txt', () => {
    const keep = new Set(lines(read('keep-inflected.txt')))
    expect(keep.size).toBeGreaterThan(10)
    expect(answers.filter((w) => /(s|ed)$/.test(w) && !keep.has(w))).toEqual([])
    // the allowlist only holds real answers, so it cannot hide a stale entry
    expect(lines(read('keep-inflected.txt')).filter((w) => !answers.includes(w))).toEqual([])
  })
  test('no answer is a comparative, superlative or -ing form of a shorter word (KA3), yet each stays a valid guess', () => {
    const keep = new Set(lines(read('keep-inflected.txt')))
    const forms = [
      'apter', 'rifer', 'eking', 'older', 'wider', 'nicer', 'safer', 'later', 'fewer', 'drier', 'icier', 'weest',
      'aging', 'acing', 'aping', 'awing', 'axing', 'cuing', 'ruing', 'suing', 'tying', 'lying', 'dying', 'vying',
      'using', 'doing', 'going', 'being', 'owing',
    ]
    for (const w of forms) {
      expect(answers).not.toContain(w)
      expect(allowed).toContain(w)
    }
    // anything still ending -er/-est/-ing is a hand-reviewed base word (a noun, verb or root), not an unreviewed form
    const rest = answers.filter((w) => /(er|est|ing)$/.test(w))
    for (const w of ['water', 'paper', 'river', 'thing', 'baker', 'crest', 'swing', 'bring']) expect(rest).toContain(w)
    expect(rest.filter((w) => keep.has(w)).length).toBeGreaterThan(40)
  })
  test('irregular plurals are not answers but stay valid guesses', () => {
    for (const w of ['teeth', 'women', 'geese', 'cacti', 'fungi', 'radii', 'genii', 'uteri', 'algae', 'pence']) {
      expect(answers).not.toContain(w)
      expect(allowed).toContain(w)
    }
  })
  test('the core version marks the current answer list', () => {
    expect(wordCore.version).toBe('word-3')
  })
  test('dropped inflections stay valid guesses', () => {
    const set = new Set(allowed)
    for (const w of ['facts', 'bored', 'cares', 'added', 'books']) expect(set.has(w)).toBe(true)
    expect(answers.includes('facts')).toBe(false)
    expect(answers.includes('bored')).toBe(false)
  })
  test('allowed is alphabetical', () => {
    expect([...allowed].sort()).toEqual(allowed)
  })
  test('the generated module matches the text files', () => {
    expect(ANSWERS_TEXT).toBe(read('answers.txt'))
    expect(ALLOWED_TEXT).toBe(read('allowed.txt'))
    expect(ANSWERS).toEqual(answers)
    expect(ALLOWED).toEqual(allowed)
  })
  test('SOURCE.md records the checksum of each list file', () => {
    const source = read('SOURCE.md')
    for (const f of ['answers.txt', 'allowed.txt', 'exclude.txt', 'keep-inflected.txt', 'drop-inflected.txt', 'guess-only.txt']) {
      expect(source).toContain(createHash('sha256').update(read(f)).digest('hex'))
    }
  })
})

describe('wordCore', () => {
  const play = (answer: string, a: string[], b: string[]) => {
    let s = wordCore.init(1, { answer })
    for (let i = 0; i < Math.max(a.length, b.length) && !wordCore.terminal(s); i++) s = wordCore.step(s, [a[i]!, b[i]!])
    return s
  }
  const answer = ANSWERS[10]!
  const other = ANSWERS.find((w) => w !== answer && fb(w, answer) !== '22222')!

  test('the seed picks the answer deterministically', () => {
    expect(wordCore.init(5).answer).toBe(wordCore.init(5).answer)
    const seen = new Set(Array.from({ length: 50 }, (_, i) => wordCore.init(i).answer))
    expect(seen.size).toBeGreaterThan(30)
  })
  test('getCore returns it and ids and actions round trip', () => {
    expect(getCore('word')).toBe(wordCore)
    expect(wordCore.decodeAction(wordCore.encodeAction(answer))).toBe(answer)
    expect(wordCore.encodeAction(answer)).toBe(allowedIndex(answer))
    expect(() => wordCore.encodeAction('zzzzz')).toThrow()
  })
  test('both seats act every round until the game ends', () => {
    const s = wordCore.init(1, { answer })
    expect(wordCore.toAct(s)).toEqual([0, 1])
    expect(wordCore.legal(s, 0)).toEqual([...ALLOWED, ...GUESS_ONLY])
    expect(wordCore.terminal(s)).toBe(false)
    expect(wordCore.result(s)).toBeNull()
  })
  test('a lone solver wins, whichever round it is', () => {
    const s = play(answer, [other, other, answer], [other, other, other])
    expect(wordCore.terminal(s)).toBe(true)
    expect(wordCore.result(s)).toEqual({ winner: 0, score: [1, 0], reason: 'solved first' })
    const t = play(answer, [other, other, other], [other, answer])
    expect(wordCore.result(t)?.winner).toBe(1)
  })
  test('solving in the same round is a draw', () => {
    const s = play(answer, [other, answer], [other, answer])
    expect(wordCore.result(s)).toEqual({ winner: null, score: [0.5, 0.5], reason: 'both solved in the same round' })
  })
  test('neither solving in six rounds is a draw', () => {
    const s = play(answer, Array(6).fill(other), Array(6).fill(other))
    expect(s.guesses[0].length).toBe(MAX_GUESSES)
    expect(wordCore.result(s)).toEqual({ winner: null, score: [0.5, 0.5], reason: 'neither solved' })
  })
  test('solving on guess six still counts, and a solve beats a failure', () => {
    const s = play(answer, [...Array(5).fill(other), answer], Array(6).fill(other))
    expect(wordCore.result(s)?.winner).toBe(0)
  })
  test('step rejects words outside the allowed list, missing guesses and play after the end', () => {
    const s = wordCore.init(1, { answer })
    expect(() => wordCore.step(s, ['zzzzz', other])).toThrow()
    expect(() => wordCore.step(s, [other, null])).toThrow()
    expect(() => wordCore.step(play(answer, [answer], [answer]), [other, other])).toThrow()
  })
  test('observe shows your letters and the other side markers only, and hides the answer until the end', () => {
    let s = wordCore.init(1, { answer })
    const theirs = ANSWERS.find((w) => w !== other && w !== answer)!
    s = wordCore.step(s, [other, theirs])
    const o0 = wordCore.observe(s, 0)
    expect(o0.guesses).toEqual([other])
    expect(o0.feedback[0]).toEqual(Array.from(feedback(other, answer)))
    expect(o0.opponent).toEqual([Array.from(feedback(theirs, answer))])
    expect(o0.answer).toBeNull()
    expect(JSON.stringify(o0)).not.toContain(theirs)
    expect(JSON.stringify(o0)).not.toContain(answer)
    s = wordCore.step(s, [answer, other])
    expect(wordCore.observe(s, 1).answer).toBe(answer)
  })
  test('hash is 16 hex chars and tracks the guesses', () => {
    const s = wordCore.init(1, { answer })
    const t = wordCore.step(s, [other, other])
    expect(wordCore.hash(s)).toMatch(/^[0-9a-f]{16}$/)
    expect(wordCore.hash(t)).not.toBe(wordCore.hash(s))
    expect(wordCore.hash(wordCore.step(s, [other, other]))).toBe(wordCore.hash(t))
  })
  test('a played match replays to its final hash', () => {
    const seed = 7
    let s = wordCore.init(seed)
    const guesses: Array<[string, string]> = [
      [ANSWERS[0]!, ANSWERS[1]!],
      [ANSWERS[2]!, s.answer],
    ]
    const actions: MatchRecordV1['actions'] = []
    guesses.forEach(([a, b], tick) => {
      actions.push([tick, 0, wordCore.encodeAction(a)], [tick, 1, wordCore.encodeAction(b)])
      s = wordCore.step(s, [a, b])
    })
    expect(wordCore.terminal(s)).toBe(true)
    const record: MatchRecordV1 = {
      schema: 1, matchId: 'w1', game: 'word', coreVersion: wordCore.version, agent: { version: 'v1', level: 'easy' },
      seed, humanSeat: 0, actions, result: wordCore.result(s)!, finalHash: wordCore.hash(s),
      startedAt: '2026-10-21T00:00:00.000Z', endedAt: '2026-10-21T00:01:00.000Z', device: 'desktop', input: 'keyboard', trainingAllowed: true,
    }
    expect(replay(decodeRecord(encodeRecord(record)))).toMatchObject({ ok: true, finalHash: record.finalHash })
    expect(replay({ ...record, finalHash: '0000000000000000' }).ok).toBe(false)
  })
})

const TEN = ['cocks', 'horny', 'penis', 'prick', 'queer', 'semen', 'sexed', 'sexes', 'spunk']

describe('guess-only words', () => {
  const exclude = lines(read('exclude.txt'))
  test('the file holds the words with an ordinary meaning; dicky is not in SCOWL size 70 or less, so it stays blocked', () => {
    expect(lines(read('guess-only.txt'))).toEqual(TEN)
    expect(GUESS_ONLY).toEqual(TEN)
    expect(GUESS_ONLY_TEXT).toBe(read('guess-only.txt'))
    expect(isAllowed('dicky')).toBe(false)
  })
  test('they are a guess and no answer, and the base list is exactly what it was', () => {
    for (const w of TEN) {
      expect(isAllowed(w)).toBe(true)
      expect(ALLOWED).not.toContain(w)
      expect(ANSWERS).not.toContain(w)
      expect(answerIndex(w)).toBe(-1)
    }
    expect(ALLOWED.length).toBe(6377)
    expect(createHash('sha256').update(read('allowed.txt')).digest('hex')).toBe('37a8bd2e58b71f24fd0a0961dca88237c43239e64d32234b382fbd7103183328')
    expect(createHash('sha256').update(read('answers.txt')).digest('hex')).toBe('f38852f396ae92dd72fb2c108ffef45e11aea4ab8583dfea18de7f6815b2486e')
  })
  test('every other excluded word is still blocked as a guess', () => {
    for (const w of exclude) expect(isAllowed(w)).toBe(TEN.includes(w))
    expect(exclude.length).toBe(71)
  })
  test('no excluded word can ever be a hidden answer', () => {
    for (const w of exclude) {
      expect(ANSWERS).not.toContain(w)
      expect(() => wordCore.init(1, { answer: w })).toThrow()
    }
    for (let seed = 0; seed < 3000; seed++) expect(exclude).not.toContain(wordCore.init(seed).answer)
  })
  test('every existing word keeps its action index; the new ones come after the last', () => {
    ALLOWED.forEach((w, i) => {
      if (allowedIndex(w) !== i) throw new Error(`${w} moved from ${i} to ${allowedIndex(w)}`)
    })
    TEN.forEach((w, i) => expect(allowedIndex(w)).toBe(ALLOWED.length + i))
    for (const w of TEN) expect(wordCore.decodeAction(wordCore.encodeAction(w))).toBe(w)
    expect(() => wordCore.decodeAction(ALLOWED.length + TEN.length)).toThrow()
  })
  test('records stored before the change replay to the same hash and result, under the same core version', () => {
    const recs = JSON.parse(read('../fixtures/word-3-records.json')) as MatchRecordV1[]
    expect(recs.length).toBe(60)
    for (const r of recs) {
      expect(r.coreVersion).toBe(wordCore.version)
      const out = replay(r)
      expect(out).toMatchObject({ ok: true, finalHash: r.finalHash })
    }
  })
  test('a record with a guess-only word replays, survives encoding, and has the right colours', () => {
    let s = wordCore.init(1)
    const answer = s.answer
    const actions: MatchRecordV1['actions'] = []
    const plan: Array<[string, string]> = [['prick', 'spunk'], ['queer', 'penis'], [answer, 'semen']]
    plan.forEach(([a, b], tick) => {
      actions.push([tick, 0, wordCore.encodeAction(a)], [tick, 1, wordCore.encodeAction(b)])
      s = wordCore.step(s, [a, b])
    })
    const record: MatchRecordV1 = {
      schema: 1, matchId: 'guess-only', game: 'word', coreVersion: wordCore.version, agent: { version: 'v1', level: 'medium' },
      seed: 1, humanSeat: 0, actions, result: wordCore.result(s)!, finalHash: wordCore.hash(s),
      startedAt: '2026-11-03T00:00:00.000Z', endedAt: '2026-11-03T00:01:00.000Z', device: 'desktop', input: 'keyboard', trainingAllowed: true,
    }
    expect(replay(decodeRecord(encodeRecord(record)))).toMatchObject({ ok: true, finalHash: record.finalHash })
    const obs = wordCore.observe(s, 0)
    expect(obs.guesses.slice(0, 2)).toEqual(['prick', 'queer'])
    expect(obs.feedback[0]).toEqual(Array.from(feedback('prick', answer)))
    expect(fb('queer', 'quiet')).toBe('22020') // markers work as for any guess
    expect(fb('sexes', 'seeds')).toBe('22012')
    expect(() => wordCore.step(wordCore.init(1), ['dicky', 'prick'])).toThrow()
  })
})
