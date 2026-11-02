import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Level } from '@duelwise/core/src/product'
import { runMatches, type GameRecord } from '../measure/harness'
import { evaluatePair, wilson, type PairStats } from '../measure/ladder'

type PairBudget = Parameters<typeof evaluatePair>[1]

/**
 * Slackwater dry ladder (SW5). Not a registry: it plays each adjacent pair through the real harness on the module-path opening core
 * and writes the numbers to the absolute path given as `out` (the CLI takes it as argv[2]). `game: 'four'` is only a label; the module-path core wins.
 * Run: nice -n 10 heavy-lock.sh bun packages/agents/src/slack/dry-ladder.ts <abs path to plan/bench/slack-dry-ladder.json>
 */
const BUDGET: PairBudget = { maxGames: 800, looks: [] }
const SEAT_GAMES = 400
const CORE = { module: import.meta.dir + '/opening.ts', export: 'createSlackOpeningCore' }
const AGENT = import.meta.dir + '/agent.ts'
const RANDOM = import.meta.dir + '/../measure/four-random.ts'

type Ref = { level: Level; module: string }
const level = (l: Level): Ref => ({ level: l, module: AGENT })

export const PAIRS: Array<{ label: string; a: Ref; b: Ref; seedBase: number }> = [
  { label: 'Pip v random', a: level('easy'), b: { level: 'easy', module: RANDOM }, seedBase: 10_000 },
  { label: 'Marlow v Pip', a: level('medium'), b: level('easy'), seedBase: 120_000 },
  { label: 'Vesper v Marlow', a: level('hard'), b: level('medium'), seedBase: 230_000 },
  { label: 'Sable v Vesper', a: level('champion'), b: level('hard'), seedBase: 340_000 },
]

export interface SeatReport {
  seat: 0 | 1
  n: number
  points: number
  score: number
  ci95: [number, number]
}
export interface PairReport extends PairStats {
  label: string
  bySeat: [SeatReport, SeatReport]
  distinctHashes: number
}
export interface LadderReport {
  generatedAt: string
  game: 'slack'
  budget: PairBudget
  pairs: PairReport[]
  allPass: boolean
}

/** Plays A v B over 800 games (A on seat index % 2), through evaluatePair, and splits A's points by A's seat. */
async function play(label: string, a: Ref, b: Ref, seedBase: number): Promise<PairReport> {
  const pts: [number, number] = [0, 0]
  const cnt: [number, number] = [0, 0]
  const hashes = new Set<string>()
  const stats = await evaluatePair(async (from, to) => {
    const seeds = Array.from({ length: to - from }, (_, i) => seedBase + from + i)
    const summary = await runMatches({ game: 'four', core: CORE, a, b, seeds, firstIndex: from }, { processes: 1 })
    let sum = 0
    for (const g of summary.games as GameRecord[]) {
      pts[g.seatOfA] += g.scoreA
      cnt[g.seatOfA]++
      hashes.add(g.hash)
      sum += g.scoreA
    }
    return sum
  }, BUDGET)
  const seat = (s: 0 | 1): SeatReport => ({ seat: s, n: cnt[s], points: pts[s], score: pts[s] / cnt[s], ci95: wilson(pts[s], SEAT_GAMES) })
  const bySeat: [SeatReport, SeatReport] = [seat(0), seat(1)]
  const perSeatOk = bySeat.every((s) => s.n === SEAT_GAMES && s.ci95[0] > 0.5)
  return { label, ...stats, passed: stats.passed && perSeatOk, bySeat, distinctHashes: hashes.size }
}

export async function runDryLadder(opts: { out?: string } = {}): Promise<LadderReport> {
  const pairs: PairReport[] = []
  for (const p of PAIRS) pairs.push(await play(p.label, p.a, p.b, p.seedBase))
  const report: LadderReport = { generatedAt: new Date().toISOString(), game: 'slack', budget: BUDGET, pairs, allPass: pairs.every((p) => p.passed) }
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true })
    writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n')
  }
  return report
}

if (import.meta.main) {
  const r = await runDryLadder({ out: process.argv[2] })
  for (const p of r.pairs) {
    console.log(`${p.label}: ${p.score.toFixed(3)} [${p.ci95[0].toFixed(3)}, ${p.ci95[1].toFixed(3)}] seat0 ${p.bySeat[0].score.toFixed(3)} (lb ${p.bySeat[0].ci95[0].toFixed(3)}) seat1 ${p.bySeat[1].score.toFixed(3)} (lb ${p.bySeat[1].ci95[0].toFixed(3)}) hashes ${p.distinctHashes} passed ${p.passed}`)
  }
  console.log('allPass', r.allPass)
  process.exit(0)
}
