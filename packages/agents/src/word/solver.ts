import { ALLOWED, ANSWERS, allowedIndex } from '@duelwise/core/src/games/word/lists'
import { patternCode } from '@duelwise/core/src/games/word/feedback'
import type { WordObs } from '@duelwise/core/src/games/word/core'
import type { Level } from '@duelwise/core/src/product'
import type { Rng } from '@duelwise/core/src/types'
import { EASY_IGNORE_CHANCE } from './levels'
import firstGuesses from './first-guesses.json'

// Pure solving code for the four Word Duel levels. Everything here depends only on the observation (your
// own guesses and the marker rows they earned), never on the hidden answer.

const L = 5
const ALL_RIGHT = 242

function pack(words: readonly string[]): Uint8Array {
  const out = new Uint8Array(words.length * L)
  words.forEach((w, i) => {
    for (let k = 0; k < L; k++) out[i * L + k] = w.charCodeAt(k) - 97
  })
  return out
}
const AL = pack(ALLOWED)
const AN = pack(ANSWERS)
const ALLOWED_OF_ANSWER = Int32Array.from(ANSWERS, (w) => allowedIndex(w))
const left = new Int8Array(26)
const marks = new Int8Array(L)

/** Pattern code of guess (an ALLOWED index) against answer (an ANSWERS index); same rule as feedback(). */
export function pat(guess: number, answer: number): number {
  const g = guess * L
  const a = answer * L
  left.fill(0)
  marks.fill(0)
  for (let i = 0; i < L; i++) {
    if (AL[g + i] === AN[a + i]) marks[i] = 2
    else left[AN[a + i]!]!++
  }
  for (let i = 0; i < L; i++) {
    if (marks[i] === 2) continue
    const c = AL[g + i]!
    if (left[c]! > 0) {
      marks[i] = 1
      left[c]!--
    }
  }
  return marks[0]! * 81 + marks[1]! * 27 + marks[2]! * 9 + marks[3]! * 3 + marks[4]!
}

/** The constraint a guess and its marker row place on the answer. */
interface Row {
  guess: number
  code: number
}

function rowsOf(obs: Pick<WordObs, 'guesses' | 'feedback'>): Row[] {
  return obs.guesses.map((w, i) => ({ guess: allowedIndex(w), code: patternCode(obs.feedback[i]!) }))
}

/** ANSWERS indices that agree with every row except the one at `skip` (none skipped by default). */
export function candidates(obs: Pick<WordObs, 'guesses' | 'feedback'>, skip = -1): number[] {
  const rows = rowsOf(obs).filter((_, i) => i !== skip)
  const out: number[] = []
  for (let a = 0; a < ANSWERS.length; a++) {
    let ok = true
    for (const r of rows) {
      if (pat(r.guess, a) !== r.code) {
        ok = false
        break
      }
    }
    if (ok) out.push(a)
  }
  return out
}

const counts = new Int32Array(243)

/** Shannon entropy (bits) of the marker pattern a guess would produce over the candidate answers. */
export function entropy(guess: number, cands: readonly number[]): number {
  counts.fill(0)
  for (const a of cands) counts[pat(guess, a)]!++
  const n = cands.length
  let h = 0
  for (let p = 0; p < 243; p++) {
    const c = counts[p]!
    if (c > 0) h -= (c / n) * Math.log2(c / n)
  }
  return h
}

/** Candidate with the best commonness rank (lowest ANSWERS index). Candidates arrive in rank order. */
const mostCommon = (cands: readonly number[]): number => ALLOWED_OF_ANSWER[cands[0]!]!

/** Two guesses whose scores differ by less than this are tied: the seed picks between them. */
const TIE = 1e-9

/** Hard: the candidate whose guess splits the candidates best. Ties go to the seed (without one, to the more common word). */
export function hardGuess(cands: readonly number[], rng?: Rng): number {
  if (cands.length <= 2) return ALLOWED_OF_ANSWER[cands[rng ? rng.int(cands.length) : 0]!]!
  const scored = cands.map((a) => ({ a, h: entropy(ALLOWED_OF_ANSWER[a]!, cands) }))
  const best = Math.max(...scored.map((x) => x.h))
  const tied = scored.filter((x) => x.h >= best - TIE)
  return ALLOWED_OF_ANSWER[tied[rng ? rng.int(tied.length) : 0]!.a]!
}

const leaf = (k: number): number => 1 + Math.log(k) / Math.log(4)
const LOOKAHEAD_TOP = 20
const EXACT_GROUP_MAX = 40

/** Splits candidates by the pattern `guess` would show; returns the groups (the all-right group included). */
function groups(guess: number, cands: readonly number[]): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const a of cands) {
    const p = pat(guess, a)
    const g = out.get(p)
    if (g) g.push(a)
    else out.set(p, [a])
  }
  return out
}

/** Expected further guesses once a group of c candidates remains, choosing the best candidate as the next guess. */
function groupCost(group: readonly number[]): number {
  const c = group.length
  if (c === 1) return 1
  if (c > EXACT_GROUP_MAX) return leaf(c)
  let best = Infinity
  for (const a of group) {
    const g = ALLOWED_OF_ANSWER[a]!
    let cost = 1
    for (const [p, sub] of groups(g, group)) if (p !== ALL_RIGHT) cost += (sub.length / c) * leaf(sub.length)
    if (cost < best) best = cost
  }
  return best
}

export interface Ranked {
  g: number
  /** Expected guesses after a second step; lower is better. */
  cost: number
  isCand: boolean
}

/** The 20 allowed words with the best entropy over the candidates, each with its two-step cost, in entropy order. */
export function championRanked(cands: readonly number[]): Ranked[] {
  const isCand = new Uint8Array(ALLOWED.length)
  for (const a of cands) isCand[ALLOWED_OF_ANSWER[a]!] = 1
  const scored: Array<{ g: number; h: number }> = []
  for (let g = 0; g < ALLOWED.length; g++) scored.push({ g, h: entropy(g, cands) })
  scored.sort((x, y) => y.h - x.h || isCand[y.g]! - isCand[x.g]! || x.g - y.g)
  return scored.slice(0, LOOKAHEAD_TOP).map(({ g }) => {
    let cost = 1
    for (const [p, group] of groups(g, cands)) if (p !== ALL_RIGHT) cost += (group.length / cands.length) * groupCost(group)
    return { g, cost, isCand: isCand[g] === 1 }
  })
}

/** Ranked entries within `margin` of the best cost, candidates first when any is among them (it can win now). */
function nearBest(ranked: readonly Ranked[], margin: number): Ranked[] {
  const best = Math.min(...ranked.map((r) => r.cost))
  const near = ranked.filter((r) => r.cost <= best + margin)
  const cand = near.filter((r) => r.isCand)
  return (cand.length > 0 ? cand : near).sort((x, y) => x.cost - y.cost)
}

/**
 * Champion: rank every allowed word by entropy over the candidates, then pick among the top 20 the one with the
 * lowest expected guesses after a second step. Ties go to the seed (without one, to the first in entropy order).
 */
export function championGuess(cands: readonly number[], rng?: Rng): number {
  if (cands.length <= 2) return ALLOWED_OF_ANSWER[cands[rng ? rng.int(cands.length) : 0]!]!
  const tied = nearBest(championRanked(cands), TIE)
  return tied[rng ? rng.int(tied.length) : 0]!.g
}

/** Number of most common answers Medium opens from. */
export const MEDIUM_OPENERS = 6
/** At most this many openers per level. */
export const OPENER_MAX = 8
/** Hard opens from answers within this many bits of the best opener. */
export const HARD_OPENER_BITS = 0.1
/** Champion opens from words within this many expected guesses (after a second step) of the best opener. */
export const CHAMPION_OPENER_GUESSES = 0.04

export interface Opener {
  first: string
  /** Second guess options by the pattern code the opener earned: the tied best guesses, one is picked by seed. */
  second: Record<string, string[]>
}
export interface FirstGuessTable {
  openers: Opener[]
}
export type FirstGuesses = Partial<Record<Level, FirstGuessTable>>

const TABLES = firstGuesses as unknown as FirstGuesses

/** The first guesses a level chooses between by seed: near-equal openers, best first. */
export function openerSet(level: 'medium' | 'hard' | 'champion'): string[] {
  if (level === 'medium') return ANSWERS.slice(0, MEDIUM_OPENERS)
  const all = candidates({ guesses: [], feedback: [] })
  if (level === 'hard') {
    const scored = all.map((a) => ({ a, h: entropy(ALLOWED_OF_ANSWER[a]!, all) })).sort((x, y) => y.h - x.h || x.a - y.a)
    return scored.filter((x) => x.h >= scored[0]!.h - HARD_OPENER_BITS).slice(0, OPENER_MAX).map((x) => ALLOWED[ALLOWED_OF_ANSWER[x.a]!]!)
  }
  return nearBest(championRanked(all), CHAMPION_OPENER_GUESSES)
    .slice(0, OPENER_MAX)
    .map((r) => ALLOWED[r.g]!)
}

/** The tied best second guesses for the candidates an opener leaves in one pattern. */
function tiedSeconds(level: 'hard' | 'champion', sub: readonly number[]): string[] {
  if (sub.length <= 2) return sub.map((a) => ANSWERS[a]!)
  if (level === 'hard') {
    const scored = sub.map((a) => ({ a, h: entropy(ALLOWED_OF_ANSWER[a]!, sub) }))
    const best = Math.max(...scored.map((x) => x.h))
    return scored.filter((x) => x.h >= best - TIE).map((x) => ANSWERS[x.a]!)
  }
  return nearBest(championRanked(sub), TIE).map((r) => ALLOWED[r.g]!)
}

/**
 * Solve step for the two entropy levels. The committed table answers the first two guesses: the opener is picked by
 * seed from the near-equal set, then the second guess by seed among the tied best. The search plays the rest.
 */
function viaTable(level: 'hard' | 'champion', obs: WordObs, cands: readonly number[], rng: Rng): number {
  const table = TABLES[level]
  if (table && obs.guesses.length === 0) return allowedIndex(table.openers[rng.int(table.openers.length)]!.first)
  if (table && obs.guesses.length === 1) {
    const opener = table.openers.find((o) => o.first === obs.guesses[0])
    const options = opener?.second[String(patternCode(obs.feedback[0]!))]
    if (options && options.length > 0) return allowedIndex(options[rng.int(options.length)]!)
  }
  return level === 'hard' ? hardGuess(cands, rng) : championGuess(cands, rng)
}

/** The ALLOWED index of the guess a level plays for this observation. */
export function chooseGuess(level: Level, obs: WordObs, rng: Rng): number {
  const cands = candidates(obs)
  if (cands.length === 0) throw new Error('word solver: no answer fits the feedback')
  switch (level) {
    case 'easy': {
      let pool = cands
      if (obs.guesses.length > 0 && rng.float() < EASY_IGNORE_CHANCE) {
        const wider = candidates(obs, rng.int(obs.guesses.length))
        if (wider.length > 0) pool = wider
      }
      return ALLOWED_OF_ANSWER[pool[rng.int(pool.length)]!]!
    }
    case 'medium':
      // A seeded opener from the six most common words; after that the most common word that fits (no ties to break).
      return obs.guesses.length === 0 ? ALLOWED_OF_ANSWER[cands[rng.int(Math.min(MEDIUM_OPENERS, cands.length))]!]! : mostCommon(cands)
    case 'hard':
      return viaTable('hard', obs, cands, rng)
    case 'champion':
      return viaTable('champion', obs, cands, rng)
  }
}

/** Computes the committed first-guess tables from scratch (run through measure.ts --first-guesses). */
export function buildFirstGuesses(): FirstGuesses {
  const out: FirstGuesses = {}
  const all = candidates({ guesses: [], feedback: [] })
  for (const level of ['hard', 'champion'] as const) {
    out[level] = {
      openers: openerSet(level).map((first) => {
        const second: Record<string, string[]> = {}
        const g = allowedIndex(first)
        for (let p = 0; p < 243; p++) {
          const sub = all.filter((a) => pat(g, a) === p)
          if (sub.length === 0) continue
          second[String(p)] = tiedSeconds(level, sub)
        }
        return { first, second }
      }),
    }
  }
  return out
}
