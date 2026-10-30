import type { GameId, Level } from '@duelwise/core/src/product'
import type { Agent, AgentOpts } from '../agent-types'
import { createGameAgent } from '../agent-dispatch'
import type { WorkerReply, WorkerRequest } from './worker'

export interface CreateAgentOpts extends AgentOpts {
  /** Test and harness hook: absolute path of a module exporting `createGameAgent(level, opts)`, used instead of the dispatch table. */
  factoryModule?: string
  /** Override the worker script (the web app can pass its own bundled URL). */
  workerUrl?: URL | string
}

export type RuntimeAgent = Agent & { preview: boolean }

/**
 * Runs the per-game agent factory inside a dedicated Web Worker so model inference never blocks the page.
 * A `core` option cannot cross the worker boundary (it holds functions), so that case, and any
 * environment without Worker, runs the same factory in this thread.
 */
export async function createAgent(game: GameId, level: Level, opts: CreateAgentOpts = {}): Promise<RuntimeAgent> {
  if (opts.core || typeof Worker === 'undefined') return createInline(game, level, opts)

  // Two literal branches: Vite only bundles a worker when it sees `new Worker(new URL(..., import.meta.url))` as is.
  const worker = opts.workerUrl ? new Worker(opts.workerUrl, { type: 'module' }) : new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let nextId = 1
  let closed = false

  const failAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }
  worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
    const p = pending.get(ev.data.id)
    if (!p) return
    pending.delete(ev.data.id)
    if (ev.data.ok) p.resolve(ev.data.result)
    else p.reject(new Error(ev.data.error))
  }
  worker.onerror = (ev: ErrorEvent) => failAll(new Error(ev.message || 'agent worker crashed'))

  const call = <T>(msg: DistributiveOmit<WorkerRequest, 'id'>): Promise<T> => {
    if (closed) return Promise.reject(new Error('agent disposed'))
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      worker.postMessage({ ...msg, id })
    })
  }

  let init: { preview: boolean }
  try {
    init = await call({ type: 'init', game, level, seat: opts.seat, factoryModule: opts.factoryModule })
  } catch (e) {
    closed = true
    worker.terminate()
    throw e
  }

  return {
    preview: init.preview,
    act: (obs, state) => call<number[]>({ type: 'act', obs, state }),
    reset(seed) {
      void call({ type: 'reset', seed }).catch(() => {})
    },
    dispose() {
      if (closed) return
      void call({ type: 'dispose' }).catch(() => {})
      closed = true
      failAll(new Error('agent disposed'))
      worker.terminate()
    },
  }
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never

async function createInline(game: GameId, level: Level, opts: CreateAgentOpts): Promise<RuntimeAgent> {
  const { factoryModule, workerUrl: _unused, ...agentOpts } = opts
  if (factoryModule) return (await import(/* @vite-ignore */ factoryModule)).createGameAgent(level, agentOpts)
  return createGameAgent(game, level, agentOpts)
}
