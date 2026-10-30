// Word Duel measurement. Run from the repo root (or give the absolute path to the file):
//   bun packages/agents/src/word/measure.ts --first-guesses
//   bun packages/agents/src/word/measure.ts --opener-gate [games]
//   bun packages/agents/src/word/measure.ts --measure
// --first-guesses rewrites first-guesses.json. --measure plays every level over every answer word (Easy over 5
// seeds), plays the duel ladder, and writes packages/agents/registry/word.json. Budgets are game counts, never time.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ladderToElo } from '@duelwise/core/src/elo'
import { wordCore, MAX_GUESSES, type WordObs } from '@duelwise/core/src/games/word/core'
import { ANSWERS, ALLOWED, allowedIndex } from '@duelwise/core/src/games/word/lists'
import { patternCode } from '@duelwise/core/src/games/word/feedback'
import { makeRng } from '@duelwise/core/src/rng'
import type { Level } from '@duelwise/core/src/product'
import { LEVELS, adjacentPairs, pairBudget } from '../runtime/levels'
import { harnessPlayPair, harnessRuntime } from '../measure/harness'
import { Z95, wilson } from '../measure/ladder'
import { parseRegistry, type Registry } from '../registry'
import { createGameAgent } from './agent'
import { WORD_LEVEL_CONFIG } from './levels'
import { buildFirstGuesses, candidates, championGuess, chooseGuess, openerSet, pat } from './solver'

const HERE = import.meta.dir
const REPO = join(HERE, '..', '..', '..', '..')
const REGISTRY_PATH = join(REPO, 'packages', 'agents', 'registry', 'word.json')
const FIRST_GUESSES_PATH = join(HERE, 'first-guesses.json')
const LISTS = join(REPO, 'packages', 'core', 'src', 'games', 'word', 'lists')

/** A word not solved in six guesses counts this many, so a failure always costs more than any solve. */
export const FAIL_COUNT = MAX_GUESSES + 1
export const EASY_SEEDS = 5
/** The seeded levels play each answer word this many times, each with a different seed, and the word's mean counts once. */
export const SEEDED_SEEDS = 3
export const METRIC = `average guesses over every answer word (a word not solved in ${MAX_GUESSES} counts ${FAIL_COUNT})`

/** Guesses one agent needs for one answer, 7 when it does not solve it in six. */
export async function solveOne(level: Level, answer: string, seed: number): Promise<number> {
  const agent = await createGameAgent(level, { seat: 0 })
  agent.reset(seed)
  let s = wordCore.init(seed, { answer })
  while (!wordCore.terminal(s)) {
    const [g] = await agent.act(wordCore.observe(s, 0))
    const word = wordCore.decodeAction(g!)
    s = wordCore.step(s, [word, word])
  }
  const n = s.guesses[0].indexOf(answer) + 1
  return n === 0 ? FAIL_COUNT : n
}

export interface LevelStats {
  level: Level
  /** Average guesses per answer word (Easy: each word averaged over its seeds first). */
  mean: number
  ci95: [number, number]
  /** Words (not word-seed pairs) measured. */
  n: number
  seeds: number
  failRate: number
  histogram: Record<string, number>
}

/** Plays `level` over `answers` (every one by default). Easy repeats over EASY_SEEDS seeds and the others over SEEDED_SEEDS: every level draws its opener (and ties) by seed. */
export async function measureLevel(level: Level, answers: readonly string[] = ANSWERS, seeds = level === 'easy' ? EASY_SEEDS : level === 'champion' || level === 'hard' || level === 'medium' ? SEEDED_SEEDS : 1): Promise<LevelStats> {
  const per: number[] = []
  const histogram: Record<string, number> = {}
  let fails = 0
  for (let i = 0; i < answers.length; i++) {
    let total = 0
    for (let k = 0; k < seeds; k++) {
      const n = await solveOne(level, answers[i]!, 100_000 * (k + 1) + i)
      total += n
      histogram[String(n)] = (histogram[String(n)] ?? 0) + 1
      if (n === FAIL_COUNT) fails++
    }
    per.push(total / seeds)
  }
  const n = per.length
  const mean = per.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(per.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
  const half = (Z95 * sd) / Math.sqrt(n)
  return { level, mean, ci95: [mean - half, mean + half], n, seeds, failRate: fails / (n * seeds), histogram }
}

/** Why a level is not publishable, or null: it must average fewer guesses than the level below with non-overlapping 95% intervals. */
export function separation(lower: LevelStats, upper: LevelStats): string | null {
  if (upper.mean < lower.mean && upper.ci95[1] < lower.ci95[0]) return null
  return `${upper.level} averages ${upper.mean.toFixed(4)} guesses [${upper.ci95[0].toFixed(4)}, ${upper.ci95[1].toFixed(4)}], not clearly fewer than ${lower.level} at ${lower.mean.toFixed(4)} [${lower.ci95[0].toFixed(4)}, ${lower.ci95[1].toFixed(4)}]`
}

/**
 * The judge's target (word-r2 fix 1): knowing the opener should gain under this much score. It is measured and
 * recorded, not enforced: near-equal openers share most letters, so a program that filters by the whole set still
 * gains about 0.07 to 0.09 (see the runlog); only a set of 100+ weaker openers gets under it, and that would flatten
 * the Hard to Champion gap.
 */
export const OPENER_GAIN_TARGET = 0.05

export interface OpenerGate {
  level: Level
  n: number
  /** Mean score (win 1, draw 0.5) of a strong player against the level without the opener hint. */
  plain: number
  /** The same player, same games, when it filters the answers by the level's opener set and the marker row it saw. */
  informed: number
  /** informed minus plain, with the 95% interval of the paired difference. */
  gain: number
  ci95: [number, number]
  /** Upper bound only: the player is told the exact opener the agent played. */
  oracleGain: number
}

type Hint = 'none' | 'set' | 'exact'

/** A strong player: Champion's first guess, then the two-step search over the answers the clues leave, optionally narrowed by the hint. */
function playerGuess(obs: WordObs, rng: ReturnType<typeof makeRng>, narrow: ((a: number) => boolean) | null): number {
  if (obs.guesses.length === 0) return chooseGuess('champion', obs, rng)
  let cands = candidates(obs)
  if (narrow) {
    const kept = cands.filter(narrow)
    if (kept.length > 0) cands = kept
  }
  return championGuess(cands, rng)
}

/** Plays one counted-style match: the strong player (seat 0) against `level` (seat 1). Returns the player's score. */
async function openerMatch(level: Level, seed: number, hint: Hint, openers: readonly string[]): Promise<number> {
  const agent = await createGameAgent(level, { seat: 1 })
  agent.reset(seed)
  const rng = makeRng(seed ^ 0x5bd1e995)
  let s = wordCore.init(seed)
  while (!wordCore.terminal(s)) {
    const mine = wordCore.observe(s, 0)
    let narrow: ((a: number) => boolean) | null = null
    if (hint !== 'none' && mine.opponent.length > 0) {
      const code = patternCode(mine.opponent[0]!)
      const pool = hint === 'exact' ? [s.guesses[1][0]!] : openers
      const idx = pool.map((w) => allowedIndex(w))
      narrow = (a) => idx.some((g) => pat(g, a) === code)
    }
    const [theirs] = await agent.act(wordCore.observe(s, 1))
    s = wordCore.step(s, [ALLOWED[playerGuess(mine, rng, narrow)]!, wordCore.decodeAction(theirs!)])
  }
  return wordCore.result(s)!.score[0]!
}

/** How much a strong player gains from knowing the level's opener set (and, as an upper bound, the exact opener). */
export async function openerGate(level: 'medium' | 'hard' | 'champion', n = 600, seedBase = 7_000_000): Promise<OpenerGate> {
  const openers = openerSet(level)
  const plain: number[] = []
  const informed: number[] = []
  const exact: number[] = []
  for (let i = 0; i < n; i++) {
    const seed = seedBase + i
    plain.push(await openerMatch(level, seed, 'none', openers))
    informed.push(await openerMatch(level, seed, 'set', openers))
    exact.push(await openerMatch(level, seed, 'exact', openers))
  }
  const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length
  const diffs = informed.map((x, i) => x - plain[i]!)
  const gain = mean(diffs)
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - gain) ** 2, 0) / (n - 1))
  const half = (Z95 * sd) / Math.sqrt(n)
  return { level, n, plain: mean(plain), informed: mean(informed), gain, ci95: [gain - half, gain + half], oracleGain: mean(exact) - mean(plain) }
}

const round = (x: number) => Math.round(x * 1e6) / 1e6
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

export interface DuelStats {
  lower: Level
  upper: Level
  n: number
  points: number
  score: number
  ci95: [number, number]
}

/** Builds the registry from the measurements: the longest prefix of levels that separate is published, the rest are "in training". */
export function buildRegistry(stats: Record<Level, LevelStats>, duels: DuelStats[], meta: { commit: string; measuredAt: string; harness: 'bun' | 'node' }, gates: OpenerGate[] = []): Registry {
  const elo = ladderToElo(duels.map((d) => ({ lower: d.lower, upper: d.upper, score: d.score })), { level: 'easy', elo: 1000 })
  const failures: Partial<Record<Level, string>> = {}
  let blocked: Level | null = null
  for (const { lower, upper } of adjacentPairs(LEVELS)) {
    const why = blocked ? `${blocked} did not pass its gate, so ${upper} was not published` : separation(stats[lower], stats[upper])
    if (why) {
      failures[upper] = `in training: ${why}`
      blocked ??= upper
    }
  }
  const reg: Registry = {
    game: 'word',
    champion: 'v1',
    versions: [
      {
        version: 'v1',
        parent: null,
        createdAt: meta.measuredAt,
        promotedAt: meta.measuredAt,
        status: 'measured',
        artifacts: {
          answers: 'packages/core/src/games/word/lists/answers.txt',
          allowed: 'packages/core/src/games/word/lists/allowed.txt',
          firstGuesses: 'packages/agents/src/word/first-guesses.json',
        },
        sha256: {
          answers: sha(join(LISTS, 'answers.txt')),
          allowed: sha(join(LISTS, 'allowed.txt')),
          firstGuesses: sha(FIRST_GUESSES_PATH),
        },
        trainedSteps: 0,
        humanMatchesUsed: 0,
        gate: {
          rule: 'each level averages fewer guesses than the level below with non-overlapping 95% confidence intervals',
          answerWords: ANSWERS.length,
          easySeeds: EASY_SEEDS,
          levels: Object.fromEntries(LEVELS.map((l) => [l, { failRate: round(stats[l].failRate), histogram: stats[l].histogram }])),
          duels: duels.map((d) => ({ ...d, score: round(d.score), ci95: [round(d.ci95[0]), round(d.ci95[1])] })),
          openerGain: {
            rule: `measured, not a publish gate: how much score a strong program gains by filtering the answers with the level's whole opener set (paired games); the exact-opener gain is an upper bound a player cannot reach; target ${OPENER_GAIN_TARGET}`,
            target: OPENER_GAIN_TARGET,
            levels: Object.fromEntries(
              gates.map((g) => [g.level, { n: g.n, plain: round(g.plain), informed: round(g.informed), gain: round(g.gain), targetMet: g.gain < OPENER_GAIN_TARGET, ci95: [round(g.ci95[0]), round(g.ci95[1])], oracleGain: round(g.oracleGain) }]),
            ),
          },
        },
      },
    ],
    levels: {},
    measured: {},
    unpublished: {},
    unpublishedConfig: {},
    learnsFromHumans: false,
  }
  for (const level of LEVELS) {
    if (failures[level]) {
      reg.unpublished![level] = failures[level]
      reg.unpublishedConfig![level] = WORD_LEVEL_CONFIG[level]
      continue
    }
    reg.levels[level] = { version: 'v1', config: WORD_LEVEL_CONFIG[level] }
    reg.measured[level] = {
      metric: METRIC,
      value: round(stats[level].mean),
      ci95: [round(stats[level].ci95[0]), round(stats[level].ci95[1])],
      n: stats[level].n,
      opponents: 'every answer word',
      siteElo: round(elo[level] ?? 1000),
      measuredAt: meta.measuredAt,
      harness: meta.harness,
      commit: meta.commit,
    }
  }
  return parseRegistry(reg)
}

async function duelLadder(): Promise<DuelStats[]> {
  const games = pairBudget('word').maxGames
  const play = harnessPlayPair({ game: 'word', agentFor: (level) => ({ level }), processes: 2, seedBase: 4_000_000 })
  const out: DuelStats[] = []
  for (const { lower, upper } of adjacentPairs(LEVELS)) {
    const points = await play({ lower, upper }, 0, games)
    out.push({ lower, upper, n: games, points, score: points / games, ci95: wilson(points, games) })
  }
  return out
}

if (import.meta.main) {
  const mode = process.argv[2]
  if (mode === '--first-guesses') {
    writeFileSync(FIRST_GUESSES_PATH, JSON.stringify(buildFirstGuesses(), null, 1) + '\n')
    console.log('wrote', FIRST_GUESSES_PATH)
  } else if (mode === '--opener-gate') {
    for (const level of ['medium', 'hard', 'champion'] as const) {
      const g = await openerGate(level, Number(process.argv[3] ?? 600))
      console.log(level, `plain ${g.plain.toFixed(4)} informed ${g.informed.toFixed(4)} gain ${g.gain.toFixed(4)} [${g.ci95.map((x) => x.toFixed(4))}] exact-opener ${g.oracleGain.toFixed(4)} n ${g.n}`)
    }
  } else if (mode === '--measure') {
    const stats = {} as Record<Level, LevelStats>
    for (const level of LEVELS) {
      stats[level] = await measureLevel(level)
      const s = stats[level]
      console.log(level, s.mean.toFixed(4), s.ci95.map((x) => x.toFixed(4)), 'fail', s.failRate.toFixed(4), JSON.stringify(s.histogram))
    }
    const duels = await duelLadder()
    for (const d of duels) console.log(`${d.upper} vs ${d.lower}`, d.points, '/', d.n, d.ci95.map((x) => x.toFixed(4)))
    const gates: OpenerGate[] = []
    for (const level of ['medium', 'hard', 'champion'] as const) {
      const g = await openerGate(level)
      gates.push(g)
      console.log('opener gate', level, `gain ${g.gain.toFixed(4)} [${g.ci95.map((x) => x.toFixed(4))}] exact-opener ${g.oracleGain.toFixed(4)} n ${g.n}`)
    }
    const dirty = spawnSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'packages']).stdout.toString().trim()
    if (dirty) {
      console.error('refusing to write the registry: packages/ has uncommitted changes, so the commit field could not reproduce these numbers\n' + dirty)
      process.exit(1)
    }
    const commit = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).stdout.toString().trim()
    const reg = buildRegistry(stats, duels, { commit, measuredAt: new Date().toISOString(), harness: harnessRuntime() }, gates)
    writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n')
    console.log('wrote', REGISTRY_PATH, 'unpublished:', JSON.stringify(reg.unpublished))
  } else {
    console.error('usage: measure.ts --first-guesses | --opener-gate [n] | --measure')
    process.exit(2)
  }
}
