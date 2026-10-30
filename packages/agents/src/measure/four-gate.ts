// The retrain promotion gate's game player (T24): a challenger Four in a Row net against the champion net, colour-swapped
// pairs from shared 2-ply random openings, both at the same fixed simulation count and no time cap.
//   bun /abs/four-gate.ts --challenger /abs/c.onnx --champion /abs/h.onnx [--games 400] [--sims 200] [--processes 2] [--seed-base 7000000]
// Prints one JSON line: { points, n, sims, processes, runtime } where points is the challenger's score (win 1, draw 0.5).
// The children the harness spawns read the two model paths from the environment (set here before they start).
import { readFileSync } from 'node:fs'
import type { Level } from '@duelwise/core/src/product'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { createGameAgent as createFourAgent } from '../four/agent'
import { createOpeningCore } from './four'
import { harnessRuntime, runMatches, type MatchJob } from './harness'

const THIS_MODULE = import.meta.path
const CHALLENGER_ENV = 'FOUR_GATE_CHALLENGER'
const CHAMPION_ENV = 'FOUR_GATE_CHAMPION'
const SIMS_ENV = 'FOUR_GATE_SIMS'

export { createOpeningCore }

/** Level 'champion' plays the challenger's net, any other level plays the champion's net; all at FOUR_GATE_SIMS simulations. */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const path = process.env[level === 'champion' ? CHALLENGER_ENV : CHAMPION_ENV]
  if (!path) throw new Error(`four-gate: ${level === 'champion' ? CHALLENGER_ENV : CHAMPION_ENV} is not set`)
  const sims = Number(process.env[SIMS_ENV] ?? 200)
  return createFourAgent('champion', { ...opts, modelBytes: new Uint8Array(readFileSync(path)), search: { sims, timeCapMs: undefined } })
}

export async function playGate(o: { challenger: string; champion: string; games: number; sims: number; processes: number; seedBase: number }) {
  process.env[CHALLENGER_ENV] = o.challenger
  process.env[CHAMPION_ENV] = o.champion
  process.env[SIMS_ENV] = String(o.sims)
  const job: MatchJob = {
    game: 'four',
    core: { module: THIS_MODULE, export: 'createOpeningCore' },
    a: { level: 'champion', module: THIS_MODULE },
    b: { level: 'hard', module: THIS_MODULE },
    seeds: Array.from({ length: o.games }, (_, i) => o.seedBase + i),
    firstIndex: 0,
  }
  const res = await runMatches(job, { processes: o.processes })
  return { points: res.scoreA, n: res.games.length, sims: o.sims, processes: o.processes, runtime: harnessRuntime() }
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
    console.error('usage: four-gate.ts --challenger <abs onnx> --champion <abs onnx> [--games 400] [--sims 200] [--processes 2] [--seed-base 7000000]')
    process.exit(2)
  }
  const out = await playGate({
    challenger,
    champion,
    games: Number(flag('--games') ?? 400),
    sims: Number(flag('--sims') ?? 200),
    processes: Math.min(2, Number(flag('--processes') ?? 2)),
    seedBase: Number(flag('--seed-base') ?? 7_000_000),
  })
  console.log(JSON.stringify(out))
  process.exit(0)
}
