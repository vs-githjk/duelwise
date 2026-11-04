// The Twelve Yards publish measurement: Pip against random legal play and every adjacent pair of levels, 400 games per seat,
// through the real harness and the agents the site serves, on the module-path penalty core. Seat 0 kicks first and the roles swap every kick,
// so "both seats" is first kicker and keeper first; the harness alternates the seat of the stronger level every game.
// A level that fails the gate on a seat, or sits above one that did, stays In training; nothing here loosens the gate.
//
//   nice -n 10 bun packages/agents/src/penalty/measure.ts --out <abs registry path> [--processes 1]
//
// It reads the registry next to this package for the version lineage, needs a committed tree (the registry records the commit), and writes only --out.
// Nobody plays against a clock: each pick is a table lookup, so the numbers do not depend on machine speed.

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { Level } from '@duelwise/core/src/product'
import { runMatches, type AgentRef, type GameRecord } from '../measure/harness'
import { publishLadder, runLadder, wilson, type LadderResult, type PairStats } from '../measure/ladder'
import { parseRegistry, writeRegistry, type Registry } from '../registry'
import { LEVELS } from '../runtime/levels'
import { PENALTY_LEVELS } from './levels'

const HERE = import.meta.dir
const REPO = join(HERE, '..', '..', '..', '..')
const REGISTRY_PATH = join(HERE, '..', '..', 'registry', 'penalty.json')
const TREE_PATHS = ['packages/agents', 'packages/core']
const TREE_EXCLUDE = ['packages/agents/registry/']
const CORE = { module: '@duelwise/core/src/games/penalty', export: 'createPenaltyCore' }
const AGENT = join(HERE, 'agent.ts')
const RANDOM_AGENT = join(HERE, '..', 'measure', 'four-random.ts')

export const GAMES_PER_SEAT = 400
const LADDER_SEEDS = 60_000_000
const BASELINE_SEEDS = 69_000_000
const round = (x: number) => Math.round(x * 1e6) / 1e6

export interface SeatRow {
  seat: number
  n: number
  points: number
  ci95: [number, number]
}
type Seated = PairStats & { bySeat: SeatRow[] }

/** The stronger level's score on each seat. Seat 0 kicks first. */
export function seatRows(games: GameRecord[]): SeatRow[] {
  return [0, 1].map((seat) => {
    const rows = games.filter((g) => g.seatOfA === seat)
    const points = rows.reduce((sum, g) => sum + g.scoreA, 0)
    return { seat, n: rows.length, points, ci95: wilson(points, rows.length) }
  })
}

/** Both seats have the full sample and a 95% Wilson lower bound above 0.5. */
export function seatsPass(rows: SeatRow[]): boolean {
  return rows.length === 2 && rows.every((s) => s.n >= GAMES_PER_SEAT && s.ci95[0] > 0.5)
}

/** A pair's result with its seats: it passes only when the pooled score and both seats pass. */
export function seated(stats: PairStats, games: GameRecord[]): Seated {
  const bySeat = seatRows(games)
  return { ...stats, bySeat, passed: stats.passed && seatsPass(bySeat) }
}

const agentRef = (level: Level): AgentRef => ({ level, module: AGENT })

async function play(a: AgentRef, b: AgentRef, base: number, from: number, to: number, processes: number, into: GameRecord[]): Promise<number> {
  // `game: 'four'` is only the harness label; the module-path core is the one played.
  const summary = await runMatches({ game: 'four', core: CORE, a, b, seeds: Array.from({ length: to - from }, (_, i) => base + from + i), firstIndex: from }, { processes })
  into.push(...summary.games)
  return summary.scoreA
}

async function ladder(processes: number): Promise<LadderResult> {
  const games: Record<string, GameRecord[]> = {}
  const result = await runLadder({
    game: 'penalty',
    levels: [...LEVELS],
    budget: { maxGames: GAMES_PER_SEAT * 2, looks: [] },
    playPair: (pair, from, to) => play(agentRef(pair.upper), agentRef(pair.lower), LADDER_SEEDS + LEVELS.indexOf(pair.upper) * 1_000_000, from, to, processes, (games[pair.upper] ??= [])),
    baseline: { label: 'random', play: (from, to) => play(agentRef('easy'), { level: 'easy', module: RANDOM_AGENT }, BASELINE_SEEDS, from, to, processes, (games.baseline ??= [])) },
  })
  return {
    ...result,
    pairs: result.pairs.map((p) => ({ ...p, ...seated(p, games[p.upper]!) })),
    baseline: result.baseline && { ...result.baseline, ...seated(result.baseline, games.baseline!) },
  }
}

const stats = (p: PairStats & { bySeat?: SeatRow[] }) => ({ n: p.n, points: p.points, score: round(p.score), ci95: p.ci95.map(round), passed: p.passed, bySeat: p.bySeat })

/** The registry a ladder earns. A failed baseline fails Pip, and publishLadder then keeps every level above a failure In training too. */
export function buildPenaltyRegistry(prior: Registry, result: LadderResult, meta: { commit: string; now: string }): Registry {
  const baseline = result.baseline
  if (!baseline) throw new Error('the Twelve Yards ladder needs its random baseline')
  const failures: Partial<Record<Level, string>> = baseline.passed ? {} : { easy: `easy does not beat ${baseline.label} from both seats` }
  const draft = structuredClone(prior)
  // The config the site plays is the one the code holds, never a hand-copied one.
  for (const level of LEVELS) {
    const was = draft.levels[level]?.config ?? draft.unpublishedConfig?.[level] ?? {}
    const config = { ...(typeof was.algorithm === 'string' ? { algorithm: was.algorithm } : {}), ...PENALTY_LEVELS[level] }
    draft.levels[level] = { version: 'v1', config }
  }
  const reg = publishLadder(draft, result, { harness: 'bun', commit: meta.commit, measuredAt: meta.now, version: 'v1', failures, allowEmpty: true })
  const version = reg.versions.find((v) => v.version === 'v1')!
  version.promotedAt = meta.now
  version.gate = {
    rule: `adjacent levels: the stronger level, and Pip against random legal play, each need a 95% Wilson lower bound above 0.5 over ${GAMES_PER_SEAT} games on each seat, not only pooled`,
    ...(baseline.passed && result.pairs.every((p) => p.passed) ? { summary: `Each level beat the level below, and Pip beat random legal play, from both seats over ${GAMES_PER_SEAT} games a seat` } : {}),
    strengthSource: 'scripted habit readers: each level is a hand-written reader of the opponent\'s earlier kicks (penalty/agent.ts, penalty/habits.ts, penalty/levels.ts), with no trained model, no self-play and no human games',
    seats: 'seat 0 kicks first and the roles swap every kick; the stronger level plays seat 0 in half the games and seat 1 in the other half, so each seat has its own sample and bound',
    searchLimit: 'no search and no clock: each pick is a table lookup from the kicks already played, so a pick is the same on every machine',
    gamesPerSeat: GAMES_PER_SEAT,
    seeds: `pair: ${LADDER_SEEDS} + 1000000 * (index of the upper level) + game index; baseline: ${BASELINE_SEEDS} + game index; the two sides swap seats every game`,
    baseline: { label: baseline.label, ...stats(baseline) },
    pairs: result.pairs.map((p) => ({ lower: p.lower, upper: p.upper, ...stats(p) })),
  }
  reg.learnsFromHumans = false
  return parseRegistry(reg)
}

async function main(): Promise<void> {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const out = arg('--out')
  if (!out) {
    console.error('usage: measure.ts --out <abs registry path> [--processes 1]')
    process.exit(2)
  }
  const { assertCleanTree } = await import('../measure/chess')
  assertCleanTree(REPO, [...TREE_PATHS, ...TREE_EXCLUDE.map((x) => `:(exclude)${x}`)])
  const commit = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).stdout.toString().trim()
  const prior = parseRegistry(JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')))
  const result = await ladder(Number(arg('--processes') ?? 1))
  const line = (name: string, p: PairStats & { bySeat?: SeatRow[] }) =>
    console.log(`${name}: ${p.points}/${p.n} score ${p.score.toFixed(4)} ${p.passed ? 'PASS' : 'FAIL'}`, (p.bySeat ?? []).map((s) => `seat ${s.seat} ${s.points}/${s.n} lower ${s.ci95[0].toFixed(4)}`).join(', '))
  if (result.baseline) line('easy vs random', result.baseline)
  for (const p of result.pairs) line(`${p.upper} vs ${p.lower}`, p)
  const reg = buildPenaltyRegistry(prior, result, { commit, now: new Date().toISOString() })
  await writeRegistry(out, reg)
  console.log('wrote', out, 'levels:', Object.keys(reg.levels).join(' '), 'unpublished:', JSON.stringify(reg.unpublished))
}

if (import.meta.main) await main()
