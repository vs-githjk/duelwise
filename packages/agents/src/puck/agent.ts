import puckRegistry from '../../registry/puck.json'
import { NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { OBS_FEATURES, VIEW_FEATURES, BIN_X, BIN_Y, binX, binY } from '@duelwise/core/src/games/puck/encode'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { SeatHands } from '@duelwise/core/src/games/puck/seat-hands'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { OrtSession, type OrtSessionOpts } from '../runtime/ort-session'
import { detExp } from './exp'
import type { Registry } from '../registry'
import { PREVIEW_MODEL, playedModel } from './models'
import { obsFromSeen, viewDue } from './view'

// The Glasscut agents: Pip (Easy) is the scripted chaser; Marlow, Vesper and Sable are league-trained MLP policies
// (two 256 tanh layers, an x head of 11 and a y head of 9 over the seat's own half). Every level goes through the
// shared SeatHands, so the browser plays the way the training env and the measurement harness play: the same
// observation (encode.ts), the same delayed view (the seat's HumanLimiter), the same target noise, the same
// minimum hold, 30 decisions a second. The page calls act() with the live observation (view.ts liveObs) on every
// frame; the agent records and decides on the frames viewDue() lists and answers with the mallet input code
// (NO_INPUT between decisions, which keeps the held target). It never reads the live puck, the live opponent or the
// live score: only the delayed view and its own hand.

export interface PuckAgentOpts extends AgentOpts {
  /** Model bytes (tests and the measurement harness). Default: fetched from /agents/puck/, or read from the repo under Bun and Node. */
  modelBytes?: Uint8Array
  ort?: OrtSessionOpts
  /** Take the likeliest target bin at every decision instead of sampling (parity and frame-for-frame tests). */
  greedy?: boolean
  /** Called at every decision with the model input and the chosen bins (measurement and tests). */
  onDecision?: (trace: PuckDecisionTrace) => void
}

export interface PuckDecisionTrace {
  frame: number
  /** The 23 features the policy read: the delayed view, then the seat's own hand. */
  seen: Float32Array
  /** The sim frame the delayed view was recorded at (frame minus this is the reaction time the agent really had). */
  viewFrame: number
  /** The target bin chosen on each axis; both -1 for the scripted Pip, which has no bins. */
  bins: [number, number]
  /** The mallet input code that went to the sim (NO_INPUT while the limiter holds nothing). */
  code: number
}

/** What the page passes as `state`: the sim frame the live observation belongs to. */
export interface PuckTick {
  frame: number
}

/** A level is published once the registry holds a measured block for it. */
export function isPublished(level: Level): boolean {
  return Object.prototype.hasOwnProperty.call(puckRegistry.measured, level)
}

export { PREVIEW_MODEL }

/** The network file a level plays, from the registry (see models.ts); null for Pip, which is a script. */
export function modelPath(level: Level, reg: Registry = puckRegistry as unknown as Registry): string | null {
  return playedModel(reg, level).path
}

async function loadModel(path: string): Promise<Uint8Array> {
  if (typeof process !== 'undefined' && process.versions?.node && typeof window === 'undefined' && typeof WorkerGlobalScope === 'undefined') {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    // Plain string work, not `new URL(..., import.meta.url)`: Vite would try to bundle the model as an asset.
    const root = fileURLToPath(import.meta.url).replace(/[/\\]packages[/\\]agents[/\\]src[/\\]puck[/\\]agent\.ts$/, '')
    return new Uint8Array(await readFile(`${root}/apps/web/public/${path}`))
  }
  const res = await fetch(`/${path}`)
  if (!res.ok) throw new Error(`puck model ${path}: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

function sample(logits: Float32Array, rng: Rng, greedy: boolean): number {
  let max = -Infinity
  for (let i = 0; i < logits.length; i++) max = Math.max(max, logits[i]!)
  if (greedy) return logits.indexOf(max)
  let sum = 0
  const p = new Float64Array(logits.length)
  for (let i = 0; i < logits.length; i++) {
    p[i] = detExp(logits[i]! - max)
    sum += p[i]!
  }
  let r = rng.float() * sum
  for (let i = 0; i < p.length; i++) {
    r -= p[i]!
    if (r < 0) return i
  }
  return p.length - 1
}

export async function createGameAgent(level: Level, opts: PuckAgentOpts = {}): Promise<PreviewAgent> {
  let seat: 0 | 1 = opts.seat ?? 1
  const path = modelPath(level)
  const delayFrames = LEVEL_LIMITS.puck[level].delayFrames
  const session = path === null ? null : await OrtSession.create(opts.modelBytes ?? (await loadModel(path)), opts.ort)
  const input = session?.inputNames[0] ?? ''
  const width = session?.inputWidth ?? OBS_FEATURES
  if (session && width !== OBS_FEATURES) throw new Error(`puck model takes ${width} features; expected ${OBS_FEATURES}`)
  let hands = new SeatHands(0, seat, level)
  let rng = makeRng(0)
  let recorded = false
  let lastDecided = -1
  let disposed = false
  const seen = new Float32Array(OBS_FEATURES)

  return {
    // Published means a measured block in the registry (P11); until then every level is the In training treatment.
    preview: !isPublished(level),
    reset(seed, atSeat) {
      if (atSeat !== undefined) seat = atSeat
      hands = new SeatHands(seed, seat, level)
      rng = makeRng((seed + 104729 * (seat + 1)) >>> 0)
      recorded = false
      lastDecided = -1
    },
    async act(obs, state) {
      if (disposed) throw new Error('agent disposed')
      const live = obs as Float32Array
      const { frame } = state as PuckTick
      if (!(live instanceof Float32Array) || live.length !== OBS_FEATURES) throw new RangeError(`puck agent: expected ${OBS_FEATURES} features`)
      const due = viewDue(frame, delayFrames)
      if (due.capture || !recorded) {
        hands.limiter.record(live.subarray(0, VIEW_FEATURES), frame)
        recorded = true
      }
      if (!due.decide || frame === lastDecided) return [NO_INPUT]
      lastDecided = frame
      // The delayed view of the match, then the hand as it is now, with the limiter's own bookkeeping.
      const viewFrame = hands.limiter.viewInto(frame, seen, 0)
      seen.set(live.subarray(VIEW_FEATURES), VIEW_FEATURES)
      const st = hands.limiter.status(frame)
      seen[OBS_FEATURES - 2] = st.sinceChange
      seen[OBS_FEATURES - 1] = st.refused
      let ux: number, uy: number, bins: [number, number] = [-1, -1]
      if (session === null) {
        const t = hands.bot('pip').act(obsFromSeen(seen))
        ux = t[0]
        uy = t[1]
      } else {
        const out = await session.run(input, seen, [1, OBS_FEATURES])
        const heads = Object.values(out)
        if (heads.length < 2 || heads[0]!.length !== BIN_X || heads[1]!.length !== BIN_Y) throw new Error('puck model has the wrong action heads')
        bins = [sample(heads[0]!, rng, opts.greedy === true), sample(heads[1]!, rng, opts.greedy === true)]
        ux = binX(bins[0])
        uy = binY(bins[1])
      }
      const code = hands.act(ux, uy, frame)
      opts.onDecision?.({ frame, viewFrame, seen: seen.slice(), bins, code })
      return [code]
    },
    dispose() {
      if (disposed) return
      disposed = true
      void session?.dispose()
    },
  }
}
