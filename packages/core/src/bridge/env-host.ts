import { createCounterGame } from '../testing/counter-game'
import { hashState } from '../hash'
import type { Seat } from '../types'
import type { Frame } from './protocol'

/**
 * A batched, auto-resetting environment driven from Python.
 * Action layout for step: Int32[n][seat 0..1][actionDims]. Reward is from seat 0's view.
 */
export interface StepOut {
  obs: Float32Array // n * prod(obsShape), already auto-reset for envs that finished
  reward: Float32Array // n
  done: Uint8Array // n
  infos: Array<Record<string, unknown>> // one per env that finished this step
}

export interface BridgeEnv {
  n: number
  obsShape: number[]
  actionDims: number
  version: string
  reset(seeds: number[]): Float32Array
  step(actions: Int32Array): StepOut
}

export type EnvFactory = (opts: { n: number; seed: number; level?: string }) => BridgeEnv

/** Test-only game id handled by the host itself. */
export const TOY_GAME = 'toy-counter'

/** Next episode seed for an env after it finishes; deterministic and distinct per env. */
export const nextSeed = (prev: number, n: number): number => (prev + n) >>> 0

export const createToyCounterEnv: EnvFactory = ({ n }) => {
  const core = createCounterGame('four')
  type S = ReturnType<typeof core.init>
  let states: S[] = []
  let seeds: number[] = []
  const OBS = 3
  const writeObs = (out: Float32Array, i: number, s: S) => {
    out[i * OBS] = s.total
    out[i * OBS + 1] = s.target
    out[i * OBS + 2] = s.turn
  }
  return {
    n,
    obsShape: [OBS],
    actionDims: 1,
    version: core.version,
    reset(newSeeds) {
      if (newSeeds.length !== n) throw new Error(`reset needs ${n} seeds, got ${newSeeds.length}`)
      seeds = newSeeds.map((s) => s >>> 0)
      states = seeds.map((s) => core.init(s))
      const obs = new Float32Array(n * OBS)
      states.forEach((s, i) => writeObs(obs, i, s))
      return obs
    },
    step(actions) {
      if (actions.length !== n * 2) throw new Error(`step needs ${n * 2} actions, got ${actions.length}`)
      const obs = new Float32Array(n * OBS)
      const reward = new Float32Array(n)
      const done = new Uint8Array(n)
      const infos: Array<Record<string, unknown>> = []
      for (let i = 0; i < n; i++) {
        const s = states[i]!
        const raw = actions[i * 2 + s.turn]!
        const a = 1 + (((raw % 3) + 3) % 3)
        const mine: [number | null, number | null] = [null, null]
        mine[s.turn as Seat] = a
        const next = core.step(s, mine)
        if (core.terminal(next)) {
          const r = core.result(next)!
          reward[i] = r.winner === 0 ? 1 : -1
          done[i] = 1
          infos.push({ env: i, winner: r.winner, score: r.score, finalHash: hashState(next), seed: seeds[i] })
          seeds[i] = nextSeed(seeds[i]!, n)
          states[i] = core.init(seeds[i]!)
        } else {
          states[i] = next
        }
        writeObs(obs, i, states[i]!)
      }
      return { obs, reward, done, infos }
    },
  }
}

const NOT_BUILT: Record<string, string> = {
  fighter: 'The fighter env is not built yet; it belongs to Lane C (T7).',
  arena: 'The arena env is not built yet; it belongs to Lane C (T10).',
}

/** Resolves the env factory for a game id. Fighter and arena load their own games/<id>/env.ts lazily. */
export async function loadEnvFactory(game: string): Promise<EnvFactory> {
  if (game === TOY_GAME) return createToyCounterEnv
  if (game === 'fighter' || game === 'arena') {
    const mod = (await import(`../games/${game}/env`)) as { createEnv: EnvFactory | null }
    if (!mod.createEnv) throw new Error(NOT_BUILT[game])
    return mod.createEnv
  }
  throw new Error(`no env for game "${game}": the turn-based games train through the self-play host or supervised data, not the env bridge`)
}

const bytesOf = (a: Float32Array | Uint8Array | Int32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)

/** Message handler. Returns the response frame bytes, or 'close' when Python asks to end the session. */
export class EnvHost {
  private ready = false

  constructor(private readonly env: BridgeEnv) {}

  handle(frame: Frame): Frame | 'close' {
    return this.dispatch(frame)
  }

  private dispatch(frame: Frame): Frame | 'close' {
    const err = (message: string): Frame => ({ header: { type: 'error', message }, payload: new Uint8Array(0) })
    try {
      switch (frame.header.type) {
        case 'hello':
          return { header: { type: 'hello', obsShape: this.env.obsShape, actionDims: this.env.actionDims, version: this.env.version, n: this.env.n }, payload: new Uint8Array(0) }
        case 'reset': {
          const seeds = frame.header.seeds
          if (!Array.isArray(seeds) || !seeds.every((s) => Number.isInteger(s))) return err('reset needs header.seeds, an array of integers')
          const obs = this.env.reset(seeds)
          this.ready = true
          return { header: { type: 'obs' }, payload: bytesOf(obs) }
        }
        case 'step': {
          if (!this.ready) return err('step before reset')
          const p = frame.payload
          if (p.length % 4 !== 0) return err(`step payload of ${p.length} bytes is not Int32`)
          const actions = new Int32Array(p.buffer.slice(p.byteOffset, p.byteOffset + p.length))
          const out = this.env.step(actions)
          const payload = new Uint8Array(out.obs.byteLength + out.reward.byteLength + out.done.byteLength)
          payload.set(bytesOf(out.obs), 0)
          payload.set(bytesOf(out.reward), out.obs.byteLength)
          payload.set(out.done, out.obs.byteLength + out.reward.byteLength)
          return { header: { type: 'step_result', infos: out.infos }, payload }
        }
        case 'close':
          return 'close'
        default:
          return err(`unknown message type ${JSON.stringify(frame.header.type)}`)
      }
    } catch (e) {
      return err((e as Error).message)
    }
  }
}
