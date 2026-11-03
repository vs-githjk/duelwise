import type { Level } from '@duelwise/core/src/product'
import type { FromWorker, ToWorker } from './worker'

/** The part of a Worker this module uses, so a test can drive it by hand. */
export interface WorkerLike {
  postMessage(message: unknown): void
  terminate(): void
  onmessage: ((e: { data: unknown }) => void) | null
  onerror: ((e: { message?: string }) => void) | null
}

export interface WorkerAgent {
  /** Seeds the opponent's own noise for a new match; the worker rebuilds its agent and queues every later act behind that. */
  reset(seed: number, seat?: 0 | 1): void
  /** The opponent's action code for an observation, as `[code]`. Rejects, and never hangs, when the worker is gone. */
  act(obs: unknown): Promise<number[]>
  dispose(): void
}

export interface WorkerAgentOptions {
  /** Builds the worker. Defaults to the real one; tests pass a fake. */
  make?: () => WorkerLike
  /** How long the script may take to load before the start fails. */
  readyMs?: number
  /** How long one reply may take (Sable's search is capped far below this) before the opponent counts as stopped. */
  actMs?: number
}

export const COULD_NOT_START = 'The opponent could not start. Check your connection, then press Start to try again.'
export const STOPPED = 'The opponent stopped. Go back to setup and start a new match.'
export const GENERIC_FAILURE = 'Something went wrong with this match. Go back to setup and start a new one.'

/** The line a player reads for a failure: ours as written, anything else (a thrown message meant for a developer) as one plain sentence. */
export function failureLine(e: unknown): string {
  const m = e instanceof Error ? e.message : ''
  return m === STOPPED || m === COULD_NOT_START ? m : GENERIC_FAILURE
}
const DISPOSED = 'disposed'

function realWorker(): WorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike
}

/**
 * The Crosscurrent opponent behind a Worker, so the HUD and taps stay live while Sable searches. Every failure ends in a rejection with
 * a plain line: a script that cannot load (offline, blocked) rejects the start, and a worker that dies, errors or goes quiet fails the
 * act in flight and every later one at once, so the page can always show a line and a way out.
 */
export function createWorkerAgent(level: Level, opts: WorkerAgentOptions = {}): Promise<WorkerAgent> {
  const worker = (opts.make ?? realWorker)()
  const readyMs = opts.readyMs ?? 15_000
  const actMs = opts.actMs ?? 30_000
  const waiting = new Map<number, { ok: (n: number) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let next = 1
  let dead: string | null = null
  let loaded: (() => void) | null = null
  let loadFailed: ((e: Error) => void) | null = null

  const settleAll = (reason: string) => {
    for (const w of waiting.values()) {
      clearTimeout(w.timer)
      w.fail(new Error(reason))
    }
    waiting.clear()
  }
  const die = (reason: string) => {
    if (dead === null) dead = reason
    worker.terminate()
    settleAll(reason)
    clearTimeout(readyTimer)
    loadFailed?.(new Error(COULD_NOT_START))
    loadFailed = null
  }

  worker.onmessage = (e) => {
    const m = e.data as FromWorker
    if (m.type === 'loaded') {
      loaded?.()
      return
    }
    if (m.type === 'ready') return
    if (m.type === 'failed' && m.id === 0) {
      // The worker could not build its agent: nothing it is asked from now on can be answered.
      die(STOPPED)
      return
    }
    const w = waiting.get(m.id)
    if (!w) return
    waiting.delete(m.id)
    clearTimeout(w.timer)
    if (m.type === 'acted') w.ok(m.action)
    else w.fail(new Error(STOPPED))
  }
  worker.onerror = () => die(STOPPED)

  let readyTimer: ReturnType<typeof setTimeout> | undefined
  const ready = new Promise<void>((ok, fail) => {
    loaded = ok
    loadFailed = fail
    readyTimer = setTimeout(() => die(STOPPED), readyMs)
  })

  return ready.then(() => {
    clearTimeout(readyTimer)
    loaded = null
    loadFailed = null
    const agent: WorkerAgent = {
      reset(seed, seat) {
        if (dead === null) worker.postMessage({ type: 'reset', level, seed, ...(seat === undefined ? {} : { seat }) } satisfies ToWorker)
      },
      act(obs) {
        if (dead !== null) return Promise.reject(new Error(dead))
        const id = next++
        return new Promise<number>((ok, fail) => {
          const timer = setTimeout(() => die(STOPPED), actMs)
          waiting.set(id, { ok, fail, timer })
          worker.postMessage({ type: 'act', id, obs } satisfies ToWorker)
        }).then((n) => [n])
      },
      dispose() {
        if (dead === null) dead = DISPOSED
        worker.terminate()
        settleAll(DISPOSED)
      },
    }
    return agent
  })
}
