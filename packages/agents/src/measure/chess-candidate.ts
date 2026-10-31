// The learn-from-humans gate for a candidate chess Hard (Vesper) policy net, e.g. the b2200 tier. It never reads or writes the registry.
//   bun /abs/chess-candidate.ts --candidate /abs/policy-b2200.onnx --vs hard|medium|twoply [--games-per-seat 400] [--seed-base 9000000]   (always 2 worker processes)
// The candidate plays with the shipped Hard settings (CHESS_LEVELS.hard) and the shipped value net; only its policy file differs.
//   --vs hard    against the Hard that is live: each seat needs a 95 percent Wilson lower bound above 0.5 over 400 games per seat
//   --vs medium  against Medium: the same rule (Hard must stay clearly above Medium)
//   --vs twoply  against the round-3 judge's 2-ply bot: the existing publish rule (pooled score 0.7, each seat 0.6, 200 per seat or more)
// Prints one JSON line: { vs, n, points, score, bySeat: [{ seat, n, points, score, ci95 }], passed, rule }.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Level } from '@duelwise/core/src/product'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { createGameAgent as createChessAgent, CHESS_LEVELS } from '../chess/agent'
import { loadModelBytes } from '../chess/model-files'
import { createPolicyAgent } from '../chess/policy-agent'
import { ValueNet } from '../chess/value-eval'
import { runMatches, harnessRuntime, type GameRecord } from './harness'
import { wilson } from './ladder'
import { createOpeningCore, twoPlyGate, CHESS_GAMES_PER_SEAT, TWOPLY_FLOOR } from './chess'

const THIS_MODULE = import.meta.path
const TWOPLY_MODULE = join(import.meta.dir, 'chess-twoply.ts')
const CANDIDATE_ENV = 'CHESS_CANDIDATE_POLICY'

export { createOpeningCore }

/** Level 'champion' plays the candidate net with the Hard settings; any other level is the shipped agent of that level. */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  if (level !== 'champion') return createChessAgent(level, opts)
  const path = process.env[CANDIDATE_ENV]
  if (!path) throw new Error(`chess-candidate: ${CANDIDATE_ENV} is not set`)
  const value = new ValueNet(await loadModelBytes('value.bin'))
  return Object.assign(await createPolicyAgent({ ...CHESS_LEVELS.hard, band: 'b2200' }, new Uint8Array(readFileSync(path)), { seat: opts.seat, value }), { preview: false })
}

export interface SeatRow {
  seat: 0 | 1
  n: number
  points: number
  score: number
  ci95: [number, number]
}

export function seatRows(games: Array<Pick<GameRecord, 'seatOfA' | 'scoreA'>>): SeatRow[] {
  return ([0, 1] as const).map((seat) => {
    const rows = games.filter((g) => g.seatOfA === seat)
    const points = rows.reduce((sum, g) => sum + g.scoreA, 0)
    return { seat, n: rows.length, points, score: rows.length ? points / rows.length : 0, ci95: wilson(points, rows.length) as [number, number] }
  })
}

/** Both seats must have `perSeat` games and a 95 percent lower bound above 0.5. */
export function wilsonSeatGate(rows: readonly SeatRow[], perSeat: number): boolean {
  return rows.every((r) => r.n >= perSeat && r.ci95[0] > 0.5)
}

export async function playCandidate(o: { candidate: string; vs: 'hard' | 'medium' | 'twoply'; gamesPerSeat: number; processes: number; seedBase: number }) {
  process.env[CANDIDATE_ENV] = o.candidate
  const games = o.gamesPerSeat * 2
  const b = o.vs === 'twoply' ? { level: 'hard' as Level, module: TWOPLY_MODULE } : { level: o.vs as Level, module: THIS_MODULE }
  const job = {
    game: 'chess' as const, core: { module: THIS_MODULE, export: 'createOpeningCore' }, a: { level: 'champion' as Level, module: THIS_MODULE }, b,
    seeds: Array.from({ length: games }, (_, i) => o.seedBase + i), firstIndex: 0,
  }
  const res = await runMatches(job, { processes: o.processes })
  const bySeat = seatRows(res.games)
  const passed = o.vs === 'twoply' ? twoPlyGate(res.games).passed && res.games.length >= games : wilsonSeatGate(bySeat, o.gamesPerSeat)
  const rule =
    o.vs === 'twoply'
      ? `pooled score at least ${TWOPLY_FLOOR}, each seat at least 0.6, 200 games per seat or more (the existing 2-ply bot gate)`
      : `${o.gamesPerSeat} games per seat, each seat's 95% Wilson lower bound above 0.5 (the minimum for a publish is ${CHESS_GAMES_PER_SEAT})`
  return { vs: o.vs, n: res.games.length, points: res.scoreA, score: res.scoreA / Math.max(1, res.games.length), bySeat, passed, rule, runtime: harnessRuntime() }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const candidate = flag('--candidate')
  const vs = flag('--vs')
  if (!candidate || !candidate.startsWith('/') || (vs !== 'hard' && vs !== 'medium' && vs !== 'twoply')) {
    console.error('usage: chess-candidate.ts --candidate <abs onnx> --vs hard|medium|twoply [--games-per-seat 400] [--seed-base 9000000]')
    process.exit(2)
  }
  const out = await playCandidate({
    candidate, vs, gamesPerSeat: Number(flag('--games-per-seat') ?? CHESS_GAMES_PER_SEAT), processes: 2, // exactly 2: the games run in child processes (a single process would import this entry module from itself and wait on it forever), and the ladder budget allows at most 2
    seedBase: Number(flag('--seed-base') ?? 9_000_000),
  })
  console.log(JSON.stringify(out))
  process.exit(0)
}
