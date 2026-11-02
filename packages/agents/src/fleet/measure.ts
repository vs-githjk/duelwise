// The Stormglass publish measurement: Pip against random legal play and every adjacent pair of levels, 400 games per seat,
// through the real harness and the agents the site serves. A level that fails stays In training.
//
//   bun packages/agents/src/fleet/measure.ts --out <registry path> [--processes 2]
//
// It reads the current registry next to this package, needs a committed tree (the registry records the commit), and writes only --out.

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { Level } from '@duelwise/core/src/product'
import { runMatches, type AgentRef, type GameRecord } from '../measure/harness'
import { publishLadder, runLadder, wilson, type LadderResult, type PairStats } from '../measure/ladder'
import { parseRegistry, writeRegistry, type Registry } from '../registry'
import { LEVELS } from '../runtime/levels'

const HERE = import.meta.dir
const REPO = join(HERE, '..', '..', '..', '..')
const REGISTRY_PATH = join(HERE, '..', '..', 'registry', 'fleet.json')
const TREE_PATHS = ['packages/agents', 'packages/core']
const TREE_EXCLUDE = ['packages/agents/registry/']

export const GAMES_PER_SEAT = 400
const LADDER_SEEDS = 30_000_000
const BASELINE_SEEDS = 39_000_000
// The random-legal-move stub plays on the core the harness hands it, so this module serves Fleet as well as Four in a Row.
const RANDOM_AGENT = join(HERE, '..', 'measure', 'four-random.ts')

export interface SeatRow {
  seat: number
  n: number
  points: number
  ci95: [number, number]
}

type Seated = PairStats & { bySeat: SeatRow[] }

/** The first player's score on each seat, in the shape Hold'em records. Seat 0 shoots first. */
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

const seated = (stats: PairStats, games: GameRecord[]): Seated => {
  const bySeat = seatRows(games)
  return { ...stats, bySeat, passed: stats.passed && seatsPass(bySeat) }
}

async function play(a: AgentRef, b: AgentRef, base: number, from: number, to: number, processes: number, into: GameRecord[]): Promise<number> {
  const summary = await runMatches({ game: 'fleet', a, b, seeds: Array.from({ length: to - from }, (_, i) => base + from + i), firstIndex: from }, { processes })
  // The harness scores a game that hits its step cap as a draw; a Fleet game always ends, so one that did not is a bug and not half a point.
  const unfinished = summary.games.filter((g) => g.winner === null)
  if (unfinished.length > 0) throw new Error(`${unfinished.length} games had no winner, first seed ${unfinished[0]!.seed}`)
  into.push(...summary.games)
  return summary.scoreA
}

async function ladder(processes: number): Promise<LadderResult> {
  const games: Record<string, GameRecord[]> = {}
  const result = await runLadder({
    game: 'fleet',
    levels: [...LEVELS],
    budget: { maxGames: GAMES_PER_SEAT * 2, looks: [] },
    playPair: (pair, from, to) => play({ level: pair.upper }, { level: pair.lower }, LADDER_SEEDS + LEVELS.indexOf(pair.upper) * 1_000_000, from, to, processes, (games[pair.upper] ??= [])),
    baseline: {
      label: 'random',
      play: (from, to) => play({ level: 'easy' }, { level: 'easy', module: RANDOM_AGENT }, BASELINE_SEEDS, from, to, processes, (games.baseline ??= [])),
    },
  })
  return {
    ...result,
    pairs: result.pairs.map((p) => ({ ...p, ...seated(p, games[p.upper]!) })),
    baseline: result.baseline && { ...result.baseline, ...seated(result.baseline, games.baseline!) },
  }
}

const round = (x: number) => Math.round(x * 1e6) / 1e6
const stats = (p: PairStats & { bySeat?: SeatRow[] }) => ({ n: p.n, points: p.points, score: round(p.score), ci95: p.ci95.map(round), passed: p.passed, bySeat: p.bySeat })

/** The registry a ladder earns. A failed baseline fails Pip, and publishLadder then keeps every level above a failure In training too. */
export function buildFleetRegistry(prior: Registry, result: LadderResult, meta: { commit: string; now: string }): Registry {
  const baseline = result.baseline
  if (!baseline) throw new Error('the Fleet ladder needs its random baseline')
  const failures: Partial<Record<Level, string>> = baseline.passed ? {} : { easy: `easy does not beat ${baseline.label} from both seats` }
  const reg = publishLadder(prior, result, { harness: 'bun', commit: meta.commit, measuredAt: meta.now, version: 'v1', failures, allowEmpty: true })
  const version = reg.versions.find((v) => v.version === 'v1')!
  version.promotedAt = meta.now
  version.gate = {
    rule: `adjacent levels: the stronger level, and Pip against random legal play, each need a 95% Wilson lower bound above 0.5 over ${GAMES_PER_SEAT} games on each seat, not only pooled`,
    strengthSource: 'scripted solver: each level is a hand-written algorithm (fleet/shooter.ts, fleet/levels.ts), with no trained model, no self-play and no human games',
    seats: 'seat 0 shoots first; setups are uniform random valid fleets at every level, so this measures shooting and not placement against people',
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
    console.error('usage: measure.ts --out <registry path> [--processes 2]')
    process.exit(2)
  }
  // Imported here so that a test of this module does not load the chess agent.
  const { assertCleanTree } = await import('../measure/chess')
  assertCleanTree(REPO, [...TREE_PATHS, ...TREE_EXCLUDE.map((x) => `:(exclude)${x}`)])
  const commit = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).stdout.toString().trim()
  const prior = parseRegistry(JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')))
  const result = await ladder(Number(arg('--processes') ?? 2))
  const line = (name: string, p: PairStats & { bySeat?: SeatRow[] }) =>
    console.log(`${name}: ${p.points}/${p.n} score ${p.score.toFixed(4)} ${p.passed ? 'PASS' : 'FAIL'}`, (p.bySeat ?? []).map((s) => `seat ${s.seat} ${s.points}/${s.n} lower ${s.ci95[0].toFixed(4)}`).join(', '))
  if (result.baseline) line('easy vs random', result.baseline)
  for (const p of result.pairs) line(`${p.upper} vs ${p.lower}`, p)
  const reg = buildFleetRegistry(prior, result, { commit, now: new Date().toISOString() })
  await writeRegistry(out, reg)
  console.log('wrote', out, 'levels:', Object.keys(reg.levels).join(' '), 'unpublished:', JSON.stringify(reg.unpublished))
}

if (import.meta.main) await main()
