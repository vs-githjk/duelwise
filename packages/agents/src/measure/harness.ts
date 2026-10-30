import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { GameId, Level } from '@duelwise/core/src/product'
import type { GameCore, Result, Seat } from '@duelwise/core/src/types'
import { getCore } from '@duelwise/core/src/games/index'
import type { Agent, AgentOpts, PreviewAgent } from '../agent-types'
import { createGameAgent } from '../agent-dispatch'
import { LEVELS } from '../runtime/levels'
import { writeStdoutAndExit } from './drain'

/** A module export that builds something: `(await import(module))[export](...args)`. */
export interface ModuleRef {
  module: string
  export: string
  args?: unknown[]
}

/** Which agent to play: the dispatch table's factory, or a module exporting `createGameAgent(level, opts)`. */
export interface AgentRef {
  level: Level
  module?: string
}

export interface MatchJob {
  game: GameId
  /** Core to play on; default `getCore(game)`. Test games come in through here. */
  core?: ModuleRef
  a: AgentRef
  b: AgentRef
  seeds: number[]
  /** Global index of seeds[0]; seat of A is (firstIndex + i) % 2, so A and B swap seats every game. */
  firstIndex?: number
  maxSteps?: number
}

export interface GameRecord {
  index: number
  seed: number
  seatOfA: 0 | 1
  winner: Seat | null
  /** 1 win, 0.5 draw or step cap, 0 loss for A. */
  scoreA: number
  steps: number
  hash: string
}

export function harnessRuntime(): 'bun' | 'node' {
  return typeof Bun !== 'undefined' ? 'bun' : 'node'
}

const DEFAULT_MAX_STEPS = 20000

/** Plays one game with an agent per seat. Realtime cores ask both seats every step. */
export async function playGame(
  core: GameCore<any, any, any>,
  agents: [Agent, Agent],
  seed: number,
  maxSteps = DEFAULT_MAX_STEPS,
): Promise<{ result: Result | null; steps: number; hash: string }> {
  agents[0].reset(seed)
  agents[1].reset(seed)
  let state = core.init(seed)
  let steps = 0
  while (!core.terminal(state) && steps < maxSteps) {
    const seats = core.toAct(state)
    const acts = await Promise.all(seats.map((seat) => agents[seat].act(core.observe(state, seat), state)))
    const actions: [unknown, unknown] = [null, null]
    seats.forEach((seat, i) => {
      const out = acts[i]!
      // Turn games return one encoded action; realtime agents may return one int per action dimension, which the core takes as is.
      actions[seat] = out.length === 1 ? core.decodeAction(out[0]!) : out
    })
    state = core.step(state, actions as [any, any])
    steps++
  }
  return { result: core.result(state), steps, hash: core.hash(state) }
}

async function resolveCore(job: MatchJob): Promise<GameCore<any, any, any>> {
  if (!job.core) return getCore(job.game)
  const mod = await import(job.core.module)
  return mod[job.core.export](...(job.core.args ?? []))
}

async function makeAgent(job: MatchJob, ref: AgentRef, core: GameCore<any, any, any>, seat: Seat): Promise<PreviewAgent> {
  const opts: AgentOpts = { core, seat }
  if (ref.module) return (await import(ref.module)).createGameAgent(ref.level, opts)
  return createGameAgent(job.game, ref.level, opts)
}

/** Plays the games at `indices` (positions in job.seeds) in this process. Used directly and by the child processes. */
export async function playChunk(job: MatchJob, indices: number[]): Promise<GameRecord[]> {
  const core = await resolveCore(job)
  const cache = new Map<string, PreviewAgent>()
  const agent = async (who: 'a' | 'b', seat: Seat) => {
    const key = who + seat
    let a = cache.get(key)
    if (!a) {
      a = await makeAgent(job, job[who], core, seat)
      cache.set(key, a)
    }
    return a
  }
  const out: GameRecord[] = []
  try {
    for (const i of indices) {
      const seed = job.seeds[i]!
      const index = (job.firstIndex ?? 0) + i
      const seatOfA = (index % 2) as 0 | 1
      const a = await agent('a', seatOfA)
      const b = await agent('b', (1 - seatOfA) as Seat)
      const pair: [Agent, Agent] = seatOfA === 0 ? [a, b] : [b, a]
      const { result, steps, hash } = await playGame(core, pair, seed, job.maxSteps)
      const winner = result?.winner ?? null
      out.push({ index, seed, seatOfA, winner, scoreA: winner === null ? 0.5 : winner === seatOfA ? 1 : 0, steps, hash })
    }
  } finally {
    for (const a of cache.values()) a.dispose()
  }
  return out
}

export interface MatchSummary {
  games: GameRecord[]
  /** Sum of A's points (win 1, draw 0.5). */
  scoreA: number
  processes: number
  /** Pids of the child processes that played; empty when everything ran in this process. */
  workerPids: number[]
  runtime: 'bun' | 'node'
}

const CHILD = fileURLToPath(import.meta.url)

function runChild(job: MatchJob, indices: number[]): Promise<{ pid: number; games: GameRecord[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], { stdio: ['pipe', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`match process exited with code ${code}`))
      try {
        resolve({ pid: child.pid!, games: JSON.parse(out) as GameRecord[] })
      } catch (e) {
        reject(e)
      }
    })
    child.stdin.end(JSON.stringify({ job, indices }))
  })
}

/**
 * Plays every seed in the job. With more than one process the games are dealt round-robin to child
 * processes (the ladder budget allows at most 2); results are merged in game order, so the numbers do not
 * depend on the process count.
 */
export async function runMatches(job: MatchJob, opts: { processes?: number } = {}): Promise<MatchSummary> {
  const processes = Math.max(1, Math.min(opts.processes ?? 1, job.seeds.length || 1))
  const all = job.seeds.map((_, i) => i)
  let games: GameRecord[]
  let workerPids: number[] = []
  if (processes === 1) {
    games = await playChunk(job, all)
  } else {
    const parts = Array.from({ length: processes }, (_, p) => all.filter((i) => i % processes === p))
    const results = await Promise.all(parts.map((idx) => runChild(job, idx)))
    games = results.flatMap((r) => r.games).sort((x, y) => x.index - y.index)
    workerPids = results.map((r) => r.pid)
  }
  return { games, scoreA: games.reduce((s, g) => s + g.scoreA, 0), processes, workerPids, runtime: harnessRuntime() }
}

export interface HarnessPairOpts {
  game: GameId
  core?: ModuleRef
  agentFor: (level: Level) => AgentRef
  processes?: number
  seedBase: number
  maxSteps?: number
}

/**
 * Adapter for runLadder: plays games [from, to) of one pair and returns the upper level's points.
 * Seeds depend only on the seed base, the upper level and the game index, so a re-run repeats exactly.
 */
export function harnessPlayPair(o: HarnessPairOpts): (pair: { lower: Level; upper: Level }, from: number, to: number) => Promise<number> {
  return async (pair, from, to) => {
    const base = o.seedBase + LEVELS.indexOf(pair.upper) * 1_000_000
    const job: MatchJob = {
      game: o.game,
      core: o.core,
      a: o.agentFor(pair.upper),
      b: o.agentFor(pair.lower),
      seeds: Array.from({ length: to - from }, (_, i) => base + from + i),
      firstIndex: from,
      maxSteps: o.maxSteps,
    }
    return (await runMatches(job, { processes: o.processes })).scoreA
  }
}

async function readStdin(): Promise<string> {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  return text
}

// Child process entry: reads { job, indices } as JSON on stdin, plays those games, prints GameRecord[] as JSON.
// Exit only once stdout has drained, or a large result is cut off while the exit code stays 0.
if (import.meta.main) {
  const { job, indices } = JSON.parse(await readStdin()) as { job: MatchJob; indices: number[] }
  const games = await playChunk(job, indices)
  writeStdoutAndExit(JSON.stringify(games))
}
