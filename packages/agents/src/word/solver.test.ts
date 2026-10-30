import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRegistry } from '../registry'
import { wordCore } from '@duelwise/core/src/games/word/core'
import { feedback, patternCode } from '@duelwise/core/src/games/word/feedback'
import { ALLOWED, ANSWERS, allowedIndex } from '@duelwise/core/src/games/word/lists'
import { makeRng } from '@duelwise/core/src/rng'
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent } from './agent'
import { measureLevel, separation, solveOne } from './measure'
import firstGuesses from './first-guesses.json'
import { buildFirstGuesses, candidates, championGuess, championRanked, chooseGuess, entropy, hardGuess, openerSet, pat } from './solver'

const sample = ANSWERS.filter((_, i) => i % 17 === 0).slice(0, 200)

describe('pattern code', () => {
  test('pat() agrees with feedback() on random pairs', () => {
    const rng = makeRng(3)
    for (let i = 0; i < 2000; i++) {
      const g = rng.int(ALLOWED.length)
      const a = rng.int(ANSWERS.length)
      expect(pat(g, a)).toBe(patternCode(feedback(ALLOWED[g]!, ANSWERS[a]!)))
    }
  })
})

/** Plays one solo solve and returns the guesses made, with the candidate list before each. */
async function trace(level: Level, answer: string, seed: number) {
  const agent = await createGameAgent(level, { seat: 0 })
  agent.reset(seed)
  let s = wordCore.init(seed, { answer })
  const steps: Array<{ guess: string; before: number[] }> = []
  while (!wordCore.terminal(s)) {
    const obs = wordCore.observe(s, 0)
    const before = candidates(obs)
    const [g] = await agent.act(obs)
    const word = wordCore.decodeAction(g!)
    steps.push({ guess: word, before })
    s = wordCore.step(s, [word, word])
  }
  return steps
}

describe('solver levels', () => {
  test('the answer is always among the candidates the feedback leaves', async () => {
    for (const level of ['medium', 'hard', 'champion'] as Level[]) {
      for (const answer of sample.slice(0, 40)) {
        for (const step of await trace(level, answer, 1)) expect(step.before).toContain(ANSWERS.indexOf(answer))
      }
    }
  })
  test('Champion solves every word in the 200-word sample within 6 guesses, each guess from the allowed list', async () => {
    for (const answer of sample) {
      const steps = await trace('champion', answer, 1)
      expect(steps.length).toBeLessThanOrEqual(6)
      expect(steps[steps.length - 1]!.guess).toBe(answer)
      for (const step of steps) expect(ALLOWED).toContain(step.guess)
    }
  }, 120_000)
  test('Medium and Hard only guess words that fit every earlier marker row', async () => {
    for (const level of ['medium', 'hard'] as Level[]) {
      for (const answer of sample.slice(0, 40)) {
        for (const step of await trace(level, answer, 1)) {
          expect(step.before.map((a) => ANSWERS[a])).toContain(step.guess)
        }
      }
    }
  })
  test('Easy sometimes plays a word that contradicts earlier feedback', async () => {
    let off = 0
    for (let i = 0; i < 150; i++) {
      for (const step of await trace('easy', sample[i % sample.length]!, i)) if (!step.before.map((a) => ANSWERS[a]).includes(step.guess)) off++
    }
    expect(off).toBeGreaterThan(0)
  })
  test('Medium opens with one of the six most common words by seed, then picks the most common word that fits', async () => {
    const opens = new Set<string>()
    for (let seed = 0; seed < 60; seed++) {
      const t = await trace('medium', sample[3]!, seed)
      opens.add(t[0]!.guess)
      for (const step of t.slice(1)) expect(step.guess).toBe(ANSWERS[step.before[0]!]!)
    }
    expect([...opens].every((w) => ANSWERS.slice(0, 6).includes(w))).toBe(true)
    expect(opens.size).toBeGreaterThanOrEqual(4)
    const a = await trace('medium', sample[3]!, 7)
    expect(a.map((s) => s.guess)).toEqual((await trace('medium', sample[3]!, 7)).map((s) => s.guess))
  })
  test('KA3: Hard and Champion open from a committed near-equal set by seed, never one fixed word', async () => {
    for (const level of ['hard', 'champion'] as const) {
      const set = firstGuesses[level].openers.map((o: { first: string }) => o.first)
      expect(set.length).toBeGreaterThanOrEqual(5)
      expect(set.length).toBeLessThanOrEqual(8)
      const opens = new Set<string>()
      for (let seed = 0; seed < 80; seed++) opens.add((await trace(level, sample[5]!, seed))[0]!.guess)
      expect([...opens].every((w) => set.includes(w))).toBe(true)
      expect(opens.size).toBeGreaterThanOrEqual(Math.min(5, set.length))
    }
  }, 60_000)
  test('KA3: later ties break by seed (Hard plays more than one game per word), and a seed repeats its game', async () => {
    for (const level of ['hard', 'champion'] as const) {
      const games = new Set<string>()
      const firsts = new Set<string>()
      for (let seed = 0; seed < 60; seed++) {
        const t = (await trace(level, sample[11]!, seed)).map((s) => s.guess)
        games.add(t.join('>'))
        firsts.add(t[0]!)
      }
      expect(games.size).toBeGreaterThan(firsts.size)
      const again = (await trace(level, sample[11]!, 9)).map((s) => s.guess)
      expect(again).toEqual((await trace(level, sample[11]!, 9)).map((s) => s.guess))
    }
  }, 60_000)
  test('KA3: with no seed a tie falls to the first option, and with a seed every tied option is reachable', () => {
    for (const level of ['hard', 'champion'] as const) {
      const opener = firstGuesses[level].openers[0] as unknown as { first: string; second: Record<string, string[]> }
      const g = allowedIndex(opener.first)
      const all = candidates({ guesses: [], feedback: [] })
      const [code, options] = Object.entries(opener.second).find(([, o]) => o.length > 1 && o.length <= 4)!
      const sub = all.filter((a) => pat(g, a) === Number(code))
      const pick = (rng?: ReturnType<typeof makeRng>) => ALLOWED[level === 'hard' ? hardGuess(sub, rng) : championGuess(sub, rng)]!
      expect(pick()).toBe(options[0]!)
      const seen = new Set<string>()
      for (let seed = 0; seed < 200; seed++) seen.add(pick(makeRng(seed)))
      expect([...seen].sort()).toEqual([...options].sort())
    }
    // two candidates left: each is equally likely, so the seed picks either
    const two = candidates({ guesses: [], feedback: [] }).slice(0, 2)
    const seen = new Set<number>()
    for (let seed = 0; seed < 50; seed++) seen.add(hardGuess(two, makeRng(seed)))
    expect(seen.size).toBe(2)
  }, 60_000)
  test('the committed first-guess tables match what the search computes', () => {
    const fresh = buildFirstGuesses()
    expect(fresh.hard).toEqual(firstGuesses.hard as unknown as typeof fresh.hard)
    expect(fresh.champion).toEqual(firstGuesses.champion as unknown as typeof fresh.champion)
    for (const level of ['hard', 'champion'] as const) {
      expect(firstGuesses[level].openers.map((o: { first: string }) => o.first)).toEqual(openerSet(level))
    }
  }, 600_000)
  test('the opener sets are near-equal: Hard within 0.1 bits of the best answer, Champion within 0.04 expected guesses', () => {
    const all = candidates({ guesses: [], feedback: [] })
    const hard = openerSet('hard')
    const best = entropy(hardGuess(all), all)
    for (const w of hard) {
      expect(ANSWERS).toContain(w)
      expect(best - entropy(allowedIndex(w), all)).toBeLessThanOrEqual(0.1 + 1e-9)
    }
    expect(ALLOWED[hardGuess(all)]).toBe(hard[0]!)
    const ranked = championRanked(all)
    const bestCost = Math.min(...ranked.map((r) => r.cost))
    const champion = openerSet('champion')
    expect(champion.length).toBeGreaterThanOrEqual(5)
    for (const w of champion) expect(ranked.find((r) => ALLOWED[r.g] === w)!.cost - bestCost).toBeLessThanOrEqual(0.04 + 1e-9)
    expect(openerSet('medium')).toEqual(ANSWERS.slice(0, 6))
  }, 120_000)
  test('a table lookup is one of the tied searches it caches', () => {
    for (const level of ['hard', 'champion'] as const) {
      const t = firstGuesses[level].openers[1] as unknown as { first: string; second: Record<string, string[]> }
      const g = allowedIndex(t.first)
      for (const a of [0, 500, 1000, ANSWERS.length - 1]) {
        const code = pat(g, a)
        const obs = { round: 1, maxGuesses: 6, guesses: [t.first], feedback: [Array.from(feedback(t.first, ANSWERS[a]!))], opponent: [], answer: null }
        const sub = candidates(obs)
        const searched = level === 'hard' ? hardGuess(sub) : championGuess(sub)
        expect(t.second[String(code)]).toContain(ALLOWED[searched]!)
        for (let seed = 0; seed < 5; seed++) expect(t.second[String(code)]).toContain(ALLOWED[chooseGuess(level, obs, makeRng(seed))]!)
      }
    }
  }, 120_000)
  test('on a 200-word sample Champion averages fewer guesses than Hard, and Hard fewer than Medium', async () => {
    const m = await measureLevel('medium', sample)
    const h = await measureLevel('hard', sample)
    const c = await measureLevel('champion', sample)
    expect(c.mean).toBeLessThan(h.mean)
    expect(h.mean).toBeLessThan(m.mean)
  }, 60_000)
  test('over every answer, Easy averages more guesses than Medium with non-overlapping intervals', async () => {
    const e = await measureLevel('easy')
    const m = await measureLevel('medium')
    expect(separation(e, m)).toBeNull()
    // JA3: a clear gap, not a hair: Easy needs at least 0.35 more guesses than Medium, and Medium rarely misses
    expect(e.mean - m.mean).toBeGreaterThanOrEqual(0.35)
    expect(e.ci95[0]).toBeGreaterThan(m.ci95[1])
    expect(m.failRate).toBeLessThanOrEqual(0.03)
  }, 120_000)
  test('solveOne reports the guesses used', async () => {
    expect(await solveOne('champion', sample[0]!, 1)).toBeLessThanOrEqual(6)
  })
  test('separation needs fewer guesses and non-overlapping intervals', () => {
    const mk = (level: Level, mean: number, half: number) => ({ level, mean, ci95: [mean - half, mean + half] as [number, number], n: 10, seeds: 1, failRate: 0, histogram: {} })
    expect(separation(mk('easy', 4.5, 0.05), mk('medium', 4.0, 0.05))).toBeNull()
    expect(separation(mk('easy', 4.1, 0.05), mk('medium', 4.0, 0.05))).not.toBeNull()
    expect(separation(mk('easy', 4.0, 0.05), mk('medium', 4.5, 0.05))).not.toBeNull()
  })
})

describe('agent', () => {
  test('is not a preview and returns one encoded ALLOWED index', async () => {
    const agent = await createGameAgent('hard', { seat: 1 })
    expect(agent.preview).toBe(false)
    agent.reset(5)
    const s = wordCore.init(5)
    const out = await agent.act(wordCore.observe(s, 1))
    expect(out.length).toBe(1)
    expect(ALLOWED[out[0]!]).toBeDefined()
    agent.dispose()
  })
  test('same seed and seat give the same Easy game; different seats differ', async () => {
    const run = async (seat: 0 | 1) => {
      const a = await createGameAgent('easy', { seat })
      a.reset(11)
      return (await a.act(wordCore.observe(wordCore.init(11), seat)))[0]
    }
    expect(await run(0)).toBe(await run(0))
    const picks = new Set<number | undefined>()
    for (let seed = 0; seed < 20; seed++) {
      for (const seat of [0, 1] as const) {
        const a = await createGameAgent('easy', { seat })
        a.reset(seed)
        picks.add((await a.act(wordCore.observe(wordCore.init(seed), seat)))[0])
      }
    }
    expect(picks.size).toBeGreaterThan(20)
  })
})

describe('registry/word.json', () => {
  const root = join(import.meta.dir, '..', '..', '..', '..')
  const reg = parseRegistry(JSON.parse(readFileSync(join(root, 'packages', 'agents', 'registry', 'word.json'), 'utf8')))
  const levels: Level[] = ['easy', 'medium', 'hard', 'champion']

  test('is valid and every level is published with a measured block', () => {
    expect(reg.game).toBe('word')
    expect(Object.keys(reg.unpublished ?? {})).toEqual([])
    for (const l of levels) expect(reg.measured[l]).toBeDefined()
  })
  test('average guesses fall level by level with non-overlapping 95% intervals', () => {
    for (let i = 1; i < levels.length; i++) {
      const lo = reg.measured[levels[i - 1]!]!
      const hi = reg.measured[levels[i]!]!
      expect(hi.value).toBeLessThan(lo.value)
      expect(hi.ci95[1]).toBeLessThan(lo.ci95[0])
      expect(hi.siteElo).toBeGreaterThan(lo.siteElo)
    }
    expect(reg.measured.easy!.siteElo).toBe(1000)
  })
  test('measured over every answer word', () => {
    for (const l of levels) expect(reg.measured[l]!.n).toBe(ANSWERS.length)
  })
  test('KA3: the opener gain is measured per seeded level and recorded with the exact-opener upper bound', () => {
    const gate = reg.versions[0]!.gate as { openerGain: { target: number; levels: Record<string, { n: number; gain: number; oracleGain: number; targetMet: boolean }> } }
    expect(gate.openerGain.target).toBe(0.05)
    for (const l of ['medium', 'hard', 'champion']) {
      const g = gate.openerGain.levels[l]!
      expect(g.n).toBeGreaterThanOrEqual(600)
      expect(g.oracleGain).toBeGreaterThanOrEqual(g.gain - 0.05)
      expect(g.targetMet).toBe(g.gain < gate.openerGain.target)
    }
    expect(reg.levels.champion!.config).toMatchObject({ opener: 'seeded-near-equal-lookahead', tieBreak: 'seed' })
  })
  test('artifact checksums match the files in the repo', () => {
    const v = reg.versions[0]!
    for (const [name, path] of Object.entries(v.artifacts)) {
      expect(v.sha256[name]).toBe(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'))
    }
  })
})
