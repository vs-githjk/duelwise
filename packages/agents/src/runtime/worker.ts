/// <reference lib="webworker" />
import type { GameId, Level } from '@duelwise/core/src/product'
import type { Agent, PreviewAgent } from '../agent-types'

export type WorkerRequest =
  | { id: number; type: 'init'; game: GameId; level: Level; seat?: 0 | 1; factoryModule?: string }
  | { id: number; type: 'reset'; seed: number }
  | { id: number; type: 'act'; obs: unknown; state?: unknown }
  | { id: number; type: 'dispose' }

export type WorkerReply = { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: string }

type Factory = (game: GameId, level: Level, opts: { seat?: 0 | 1 }, factoryModule?: string) => Promise<PreviewAgent>

const defaultFactory: Factory = async (game, level, opts, factoryModule) => {
  if (factoryModule) return (await import(/* @vite-ignore */ factoryModule)).createGameAgent(level, opts)
  const { createGameAgent } = await import('../agent-dispatch')
  return createGameAgent(game, level, opts)
}

/** Message handler for one agent. Requests run strictly in arrival order, so a reset sent before an act always lands first. */
export function createWorkerHost(factory: Factory = defaultFactory): (msg: WorkerRequest) => Promise<WorkerReply> {
  let agent: Agent | null = null
  let tail: Promise<unknown> = Promise.resolve()
  const run = async (msg: WorkerRequest): Promise<WorkerReply> => {
    try {
      switch (msg.type) {
        case 'init': {
          agent?.dispose()
          const made = await factory(msg.game, msg.level, { seat: msg.seat }, msg.factoryModule)
          agent = made
          return { id: msg.id, ok: true, result: { preview: made.preview } }
        }
        case 'reset':
          if (!agent) throw new Error('agent not initialised')
          agent.reset(msg.seed)
          return { id: msg.id, ok: true }
        case 'act':
          if (!agent) throw new Error('agent not initialised')
          return { id: msg.id, ok: true, result: await agent.act(msg.obs, msg.state) }
        case 'dispose':
          agent?.dispose()
          agent = null
          return { id: msg.id, ok: true }
      }
    } catch (e) {
      return { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  return (msg) => {
    const next = tail.then(() => run(msg))
    tail = next
    return next
  }
}

// Wire up only when this file is the entry of a dedicated worker.
// Browsers expose WorkerGlobalScope; Bun workers do not, so Bun.isMainThread decides there.
const inWorker =
  typeof WorkerGlobalScope !== 'undefined'
    ? self instanceof WorkerGlobalScope
    : typeof Bun !== 'undefined' && !Bun.isMainThread
if (inWorker) {
  const host = createWorkerHost()
  self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
    void host(ev.data).then((reply) => self.postMessage(reply))
  }
}
