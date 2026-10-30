import fighterRegistry from '../../registry/fighter.json'
import { LEVEL_LIMITS, type LimiterConfig } from '@duelwise/core/src/limiter'
import { STAGE_HALF } from '@duelwise/core/src/games/fighter/constants'
import { DIR, N_BUTTONS, N_DIRS, mirrorDir } from '@duelwise/core/src/games/fighter/input'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { OrtSession, type OrtSessionOpts } from '../runtime/ort-session'
import { BUTTON_HEAD, FighterSeatInput, KEEP_BUTTON, OBS_FEATURES, V2_FEATURES, viewDue } from './view'

// The fighter agent (T34, T8c): a league-trained MLP policy (two 256 tanh layers, a 9-way direction head and a
// button head) behind the same HumanLimiter the env trains with. A v1 model (143 inputs, 7 buttons) reads the
// delayed view only; a v2 model (162 inputs, 8 buttons, R15) also reads the seat's own input state and may
// choose KEEP_BUTTON. The version is read from the model's input width. The page calls act() on the frames
// viewDue() lists, passing the seat's live view; the agent keeps the delayed views itself, so what it
// reacts to is exactly `delayFrames` old, and the APM cap and minimum hold filter what it presses.

export interface FighterAgentOpts extends AgentOpts {
  /** Model bytes (tests and the measurement harness). Default: fetched from /agents/fighter/preview/, or read from the repo under Bun and Node. */
  modelBytes?: Uint8Array
  ort?: OrtSessionOpts
  /** Called at every decision with the sim frame of the delayed view the model is about to read (measurement). */
  onObserve?: (sourceFrame: number) => void
  /** Decision trace for measurement. */
  onDecision?: (trace: { frame: number; dir: number; btn: number; input: number[]; refused: boolean }) => void
  /** Limiter override. Tests only: a negative probe builds the agent without its level's delay. */
  limits?: LimiterConfig
  /** Negative canary only: bypass the runtime action layer. */
  disableActionLayer?: boolean
}

/** What the page passes as `state`: the sim frame and the frame the round's fight phase began. */
export interface FighterTick {
  frame: number
  anchor: number
}

// R50: all levels use the same network, with publication determined by the registry.
export const PUBLISHED_V1: readonly Level[] = Object.keys(fighterRegistry.levels) as Level[]
export const PRACTICE_MODELS: Record<Level, string> = {
  easy: 'agents/fighter/v1/hard.onnx', medium: 'agents/fighter/v1/hard.onnx',
  hard: 'agents/fighter/v1/hard.onnx', champion: 'agents/fighter/v1/hard.onnx',
}

function modelPath(level: Level): string {
  return PRACTICE_MODELS[level]
}

async function loadModel(level: Level): Promise<Uint8Array> {
  const path = modelPath(level)
  if (typeof process !== 'undefined' && process.versions?.node && typeof window === 'undefined' && typeof WorkerGlobalScope === 'undefined') {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    // Plain string work, not `new URL(..., import.meta.url)`: Vite would try to bundle the model as an asset.
    const root = fileURLToPath(import.meta.url).replace(/[/\\]packages[/\\]agents[/\\]src[/\\]fighter[/\\]agent\.ts$/, '')
    return new Uint8Array(await readFile(`${root}/apps/web/public/${path}`))
  }
  const res = await fetch(`/${path}`)
  if (!res.ok) throw new Error(`fighter model ${path}: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

function sample(logits: Float32Array, from: number, n: number, rng: Rng): number {
  let max = -Infinity
  for (let i = 0; i < n; i++) max = Math.max(max, logits[from + i]!)
  let sum = 0
  const p = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    p[i] = Math.exp(logits[from + i]! - max)
    sum += p[i]!
  }
  let r = rng.float() * sum
  for (let i = 0; i < n; i++) {
    r -= p[i]!
    if (r < 0) return i
  }
  return n - 1
}

export async function createGameAgent(level: Level, opts: FighterAgentOpts = {}): Promise<PreviewAgent> {
  const seat = opts.seat ?? 1
  const cfg = opts.limits ?? LEVEL_LIMITS.fighter[level]
  const session = await OrtSession.create(opts.modelBytes ?? (await loadModel(level)), opts.ort)
  const input = session.inputNames[0]!
  const width = session.inputWidth ?? OBS_FEATURES
  if (width !== OBS_FEATURES && width !== V2_FEATURES) throw new Error(`fighter model takes ${width} features; expected ${OBS_FEATURES} (v1) or ${V2_FEATURES} (v2)`)
  const v2 = width === V2_FEATURES
  const buttonHead = v2 ? BUTTON_HEAD : N_BUTTONS
  const hands = new FighterSeatInput(cfg, seat)
  let rng = makeRng(0)
  let last: number[] = [0, 0]
  let disposed = false
  let attackButton = 0, attackRun = 0, idleRun = 0
  let lastAttack = 0, repeatedAttacks = 0

  return {
    preview: !PUBLISHED_V1.includes(level),
    reset(seed) {
      hands.reset(seed)
      rng = makeRng((seed + 104729 * (seat + 1)) >>> 0)
      last = [0, 0]
      attackButton = 0; attackRun = 0; idleRun = 0
      lastAttack = 0; repeatedAttacks = 0
    },
    async act(obs, state) {
      if (disposed) throw new Error('agent disposed')
      const view = obs as Float32Array
      const tick = state as FighterTick
      if (!(view instanceof Float32Array) || view.length !== OBS_FEATURES) throw new RangeError(`fighter agent: expected ${OBS_FEATURES} features`)
      if (tick.frame === tick.anchor) hands.startRound()
      const due = viewDue(tick.frame, tick.anchor, cfg.delayFrames)
      if (due.capture) hands.record(view, tick.frame)
      if (!due.decide) return [...last]
      const seen = new Float32Array(width)
      hands.observe(tick.frame, seen, v2)
      opts.onObserve?.(hands.observedFrame)
      const out = await session.run(input, seen, [1, width])
      const heads = Object.values(out)
      const dirLogits = heads[0]!
      const btnLogits = heads[1]!
      if (dirLogits.length !== N_DIRS || btnLogits.length !== buttonHead) throw new Error('fighter model has the wrong action heads')
      let dir = sample(dirLogits, 0, N_DIRS, rng)
      let btn = sample(btnLogits, 0, buttonHead, rng)
      const rawDir = dir, rawBtn = btn
      const status = hands.limiter.status(tick.frame)
      const heldDir = hands.mirrored === 1 ? mirrorDir(status.held[0]) : status.held[0]
      const heldButton = status.held[1]
      if (!opts.disableActionLayer) {
      // Held buttons do not retrigger attacks. Release after twelve decisions so a
      // stuck KEEP or a spent APM window cannot leave one button down indefinitely.
      if (attackRun >= 12 && heldButton === attackButton) btn = 0
      else if (attackRun >= 6 && heldButton === attackButton) {
        const repeated = Math.max(btnLogits[attackButton]!, v2 ? btnLogits[KEEP_BUTTON]! : -Infinity)
        const alternatives = Array.from(btnLogits, (v, i) => i !== attackButton && i !== KEEP_BUTTON ? v : -Infinity)
        if (Math.max(...alternatives) >= repeated - 1) {
          const adjusted = new Float32Array(btnLogits)
          adjusted[attackButton] = -Infinity
          if (v2) adjusted[KEEP_BUTTON] = -Infinity
          btn = sample(adjusted, 0, buttonHead, rng)
        }
      }
      // Count fresh presses across releases, not just a held button: this is
      // what actually retriggers a move in the simulation.
      if (repeatedAttacks >= 3 && btn === lastAttack && heldButton !== lastAttack) {
        const alternative = Math.max(...Array.from(btnLogits, (v, i) => i !== lastAttack && i !== KEEP_BUTTON ? v : -Infinity))
        if (alternative >= btnLogits[lastAttack]! - 1) {
          const adjusted = new Float32Array(btnLogits)
          adjusted[lastAttack] = -Infinity
          if (v2) adjusted[KEEP_BUTTON] = -Infinity
          btn = sample(adjusted, 0, buttonHead, rng)
        }
      }
      // The first of the encoder's nine cross features is normalized dx.
      const gap = seen[OBS_FEATURES - 10]! * (2 * STAGE_HALF)
      const far = gap > 300
      const isNeutral = heldDir === 0 && heldButton === 0
      idleRun = far && isNeutral ? idleRun + 1 : 0
      if (idleRun >= 8 && far && isNeutral) { dir = DIR.R; btn = 0 }
      // Reserve the last APM slot for escaping a neutral input at range. When
      // the window is empty, retain movement at range rather than release it.
      if (cfg.apmCap && status.slotsLeft <= 1 / cfg.apmCap + 1e-9) {
        if (far && heldDir !== 0 && dir === 0) dir = heldDir
        if (status.slotsLeft > 0 && !(idleRun >= 8 && isNeutral)) {
          const proposedDir = btn === KEEP_BUTTON ? heldDir : dir
          const proposedBtn = btn === KEEP_BUTTON ? heldButton : btn
          if ((proposedDir !== 0 && proposedDir !== heldDir) || (proposedBtn !== 0 && proposedBtn !== heldButton)) {
            dir = heldDir; btn = attackRun >= 12 ? 0 : heldButton
          }
        }
      }
      }
      // The policy chose in its own view (it stands on the left); choose() mirrors back to the screen like the env does.
      last = hands.choose(dir, btn, tick.frame)
      if (last[1] !== 0 && last[1] !== heldButton) {
        if (last[1] === lastAttack) repeatedAttacks++
        else { lastAttack = last[1]!; repeatedAttacks = 1 }
      }
      if (last[1] !== 0 && last[1] === attackButton) attackRun++
      else { attackButton = last[1]!; attackRun = attackButton ? 1 : 0 }
      opts.onDecision?.({ frame: tick.frame, dir: rawDir, btn: rawBtn, input: [...last], refused: hands.limiter.status(tick.frame).refused === 1 })
      return [...last]
    },
    dispose() {
      if (disposed) return
      disposed = true
      void session.dispose()
    },
  }
}
