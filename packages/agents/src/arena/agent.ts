import arenaRegistry from '../../registry/arena.json'
import { ACTION_NVEC, ACTION_NVEC_V2, badHead } from '@duelwise/core/src/games/arena/actions'
import { LEVEL_LIMITS, type LimiterConfig } from '@duelwise/core/src/limiter'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { OrtSession, type OrtSessionOpts } from '../runtime/ort-session'
import { ArenaSeatInput, OBS_FEATURES, V2_FEATURES, viewDue } from './view'

// The arena agent (T36, T8c): a league-trained MLP policy (nine action heads, see actions.ts) behind the same
// HumanLimiter the env trains with. The page calls act() on the frames viewDue() lists, passing the seat's
// live view; the agent keeps the delayed views itself, so what it reacts to is exactly `delayFrames` old,
// and the APM cap, minimum hold and aim limits filter what it does, as in the env's seatInput(). A v1 model
// reads the delayed view only; a v2 model (R15) also reads the seat's own input state and has a move head of
// ten, whose last value keeps the held input. The version is read from the model's input width.

export interface ArenaAgentOpts extends AgentOpts {
  /** Model bytes (tests and the measurement harness). Default: the level's published or preview model, fetched from /agents/arena/, or read from the repo under Bun and Node. */
  modelBytes?: Uint8Array
  ort?: OrtSessionOpts
  /** Called at every decision with the sim frame of the delayed view the model is about to read (measurement). */
  onObserve?: (sourceFrame: number) => void
  /** Limiter override. Tests only: a negative probe builds the agent without its level's delay or aim limit. */
  limits?: LimiterConfig
  /** Take the likeliest action at every decision instead of sampling (tests that compare a run with the training env frame for frame). */
  greedy?: boolean
}

/** What the page passes as `state`: the sim frame, the frame the current phase began, the phase and this seat's weapon. */
export interface ArenaTick {
  frame: number
  anchor: number
  phase: number
  weapon: number
}

/**
 * The reply: `first` is the packed input for the first sim frame after a decision (it carries the buy
 * choice and a fresh trigger press), `rest` the packed input for every later frame until the next
 * decision, and `decided` is 1 when this call was a decision (a capture-only call answers `rest` twice, 0).
 */
export type ArenaReply = [first: number, rest: number, decided: 0 | 1]

export const PUBLISHED_V1: readonly Level[] = Object.keys(arenaRegistry.levels) as Level[]
export const PRACTICE_MODELS: Record<Level, string> = {
  easy: 'agents/arena/v1/easy.onnx',
  medium: 'agents/arena/v1/easy.onnx',
  hard: 'agents/arena/practice/hard-b3.onnx',
  champion: 'agents/arena/v1/champion.onnx',
}

function modelPath(level: Level): string {
  return PUBLISHED_V1.includes(level) ? `agents/arena/v1/${level}.onnx` : PRACTICE_MODELS[level]
}

async function loadModel(level: Level): Promise<Uint8Array> {
  const path = modelPath(level)
  if (typeof process !== 'undefined' && process.versions?.node && typeof window === 'undefined' && typeof WorkerGlobalScope === 'undefined') {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    // Plain string work, not `new URL(..., import.meta.url)`: Vite would try to bundle the model as an asset.
    const root = fileURLToPath(import.meta.url).replace(/[/\\]packages[/\\]agents[/\\]src[/\\]arena[/\\]agent\.ts$/, '')
    return new Uint8Array(await readFile(`${root}/apps/web/public/${path}`))
  }
  const res = await fetch(`/${path}`)
  if (!res.ok) throw new Error(`arena model ${path}: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

function sample(logits: Float32Array, rng: Rng, greedy = false): number {
  let max = -Infinity
  for (let i = 0; i < logits.length; i++) max = Math.max(max, logits[i]!)
  if (greedy) return logits.indexOf(max)
  let sum = 0
  const p = new Float64Array(logits.length)
  for (let i = 0; i < logits.length; i++) {
    p[i] = Math.exp(logits[i]! - max)
    sum += p[i]!
  }
  let r = rng.float() * sum
  for (let i = 0; i < p.length; i++) {
    r -= p[i]!
    if (r < 0) return i
  }
  return p.length - 1
}

export async function createGameAgent(level: Level, opts: ArenaAgentOpts = {}): Promise<PreviewAgent> {
  const seat = opts.seat ?? 1
  const cfg = opts.limits ?? LEVEL_LIMITS.arena[level]
  const session = await OrtSession.create(opts.modelBytes ?? (await loadModel(level)), opts.ort)
  const input = session.inputNames[0]!
  const width = session.inputWidth ?? OBS_FEATURES
  if (width !== OBS_FEATURES && width !== V2_FEATURES) throw new Error(`arena model takes ${width} features; expected ${OBS_FEATURES} (v1) or ${V2_FEATURES} (v2)`)
  const v2 = width === V2_FEATURES
  const nvec = v2 ? ACTION_NVEC_V2 : ACTION_NVEC
  const hands = new ArenaSeatInput(cfg, seat)
  let rng = makeRng(0)
  let rest = 0
  let disposed = false

  return {
    // A level published from the R15-gated, Levels-rule-passing snapshot is measured, so it is not a preview (C2); the others share the preview network.
    preview: !PUBLISHED_V1.includes(level),
    reset(seed) {
      hands.reset(seed)
      rng = makeRng((seed + 104729 * (seat + 1)) >>> 0)
      rest = 0
    },
    async act(obs, state) {
      if (disposed) throw new Error('agent disposed')
      const view = obs as Float32Array
      const tick = state as ArenaTick
      if (!(view instanceof Float32Array) || view.length !== OBS_FEATURES) throw new RangeError(`arena agent: expected ${OBS_FEATURES} features`)
      if (tick.frame === tick.anchor) hands.startPhase()
      const due = viewDue(tick.frame, tick.anchor, cfg.delayFrames, tick.phase)
      if (due.capture) hands.record(view, tick.frame)
      if (!due.decide) return [rest, rest, 0] satisfies ArenaReply
      const seen = new Float32Array(width)
      hands.observe(tick.frame, seen, v2)
      opts.onObserve?.(hands.observedFrame)
      const out = await session.run(input, seen, [1, width])
      const logits = Object.values(out)
      if (logits.length < nvec.length || nvec.some((n, d) => logits[d]!.length !== n)) throw new Error('arena model has the wrong action heads')
      const heads = new Int32Array(nvec.length)
      for (let d = 0; d < heads.length; d++) heads[d] = sample(logits[d]!, rng, opts.greedy)
      if (badHead(heads, 0) >= 0) throw new Error('arena model produced an illegal action')
      const [first, later] = hands.decide(heads, tick.frame, tick.phase, tick.weapon)
      rest = later
      return [first, rest, 1] satisfies ArenaReply
    },
    dispose() {
      if (disposed) return
      disposed = true
      void session.dispose()
    },
  }
}
