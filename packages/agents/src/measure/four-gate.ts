// The retrain promotion gate's game player (T24): a challenger Four in a Row net against the champion net, colour-swapped
// pairs from shared 2-ply random openings, both at the same fixed simulation count and no time cap.
//   bun /abs/four-gate.ts --challenger /abs/c.onnx --champion /abs/h.onnx [--games 400] [--sims 200] [--processes 2] [--seed-base 7000000]
// Prints one JSON line: { points, n, sims, processes, runtime, bySeat } where points is the challenger's score (win 1, draw 0.5) and bySeat
// holds each seat's own games, points, score and 95% Wilson interval (n games alternate seats, so 800 games is 400 per seat).
// With --starts <json { positions: number[][] }> the games start from positions people reached (the holdout check of the learn command):
// seeds 2k and 2k+1 share position k mod the number of positions, so each position is played from both seats.
// The children the harness spawns read the two model paths from the environment (set here before they start).
import { readFileSync } from 'node:fs'
import type { Level } from '@duelwise/core/src/product'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { createGameAgent as createFourAgent } from '../four/agent'
import { createOpeningCore } from './four'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { harnessRuntime, runMatches, type MatchJob } from './harness'
import { wilson } from './ladder'

const THIS_MODULE = import.meta.path
const CHALLENGER_ENV = 'FOUR_GATE_CHALLENGER'
const CHAMPION_ENV = 'FOUR_GATE_CHAMPION'
const SIMS_ENV = 'FOUR_GATE_SIMS'
const STARTS_ENV = 'FOUR_GATE_STARTS'

export { createOpeningCore }

/** Level 'champion' plays the challenger's net, any other level plays the champion's net; all at FOUR_GATE_SIMS simulations. */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const path = process.env[level === 'champion' ? CHALLENGER_ENV : CHAMPION_ENV]
  if (!path) throw new Error(`four-gate: ${level === 'champion' ? CHALLENGER_ENV : CHAMPION_ENV} is not set`)
  const sims = Number(process.env[SIMS_ENV] ?? 200)
  return createFourAgent('champion', { ...opts, modelBytes: new Uint8Array(readFileSync(path)), search: { sims, timeCapMs: undefined } })
}

/** A Four in a Row core that starts from the positions in FOUR_GATE_STARTS (column lists), one per seed pair. */
export function createStartsCore(): typeof fourCore {
  const file = process.env[STARTS_ENV]
  if (!file) throw new Error(`four-gate: ${STARTS_ENV} is not set`)
  const positions = (JSON.parse(readFileSync(file, 'utf8')) as { positions: number[][] }).positions
  if (positions.length === 0) throw new Error('four-gate: the starts file has no positions')
  return {
    ...fourCore,
    init(seed, opts) {
      let s = fourCore.init(seed, opts)
      for (const col of positions[Math.floor(seed / 2) % positions.length]!) {
        const seat = fourCore.toAct(s)[0]!
        const move = fourCore.legal(s, seat).find((m) => fourCore.encodeAction(m) === col)
        if (move === undefined) throw new Error(`four-gate: column ${col} is not legal in a start position`)
        s = fourCore.step(s, seat === 0 ? [move, null] : [null, move])
      }
      return s
    },
  }
}

export async function playGate(o: { challenger: string; champion: string; games: number; sims: number; processes: number; seedBase: number; starts?: string }) {
  if (o.starts) process.env[STARTS_ENV] = o.starts
  process.env[CHALLENGER_ENV] = o.challenger
  process.env[CHAMPION_ENV] = o.champion
  process.env[SIMS_ENV] = String(o.sims)
  const job: MatchJob = {
    game: 'four',
    core: { module: THIS_MODULE, export: o.starts ? 'createStartsCore' : 'createOpeningCore' },
    a: { level: 'champion', module: THIS_MODULE },
    b: { level: 'hard', module: THIS_MODULE },
    seeds: Array.from({ length: o.games }, (_, i) => o.seedBase + i),
    firstIndex: 0,
  }
  const res = await runMatches(job, { processes: o.processes })
  const bySeat = ([0, 1] as const).map((seat) => {
    const rows = res.games.filter((g) => g.seatOfA === seat)
    const points = rows.reduce((sum, g) => sum + g.scoreA, 0)
    return { seat, n: rows.length, points, score: rows.length ? points / rows.length : 0, ci95: wilson(points, rows.length) }
  })
  return { points: res.scoreA, n: res.games.length, sims: o.sims, processes: o.processes, runtime: harnessRuntime(), bySeat }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const challenger = flag('--challenger')
  const champion = flag('--champion')
  if (!challenger || !champion) {
    console.error('usage: four-gate.ts --challenger <abs onnx> --champion <abs onnx> [--games 400] [--sims 200] [--processes 2] [--seed-base 7000000] [--starts <abs json>]')
    process.exit(2)
  }
  const out = await playGate({
    challenger,
    champion,
    games: Number(flag('--games') ?? 400),
    sims: Number(flag('--sims') ?? 200),
    processes: Math.min(2, Number(flag('--processes') ?? 2)),
    seedBase: Number(flag('--seed-base') ?? 7_000_000),
    starts: flag('--starts'),
  })
  console.log(JSON.stringify(out))
  process.exit(0)
}
