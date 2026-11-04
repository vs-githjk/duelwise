/// <reference lib="webworker" />
// Crosscurrent agent host. The search runs here so the page's HUD pulse and taps stay live during Sable's search,
// the way the shipped agents run. One request at a time: the page sends 'reset' once, then one 'act' per agent turn.
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent } from '@duelwise/agents/src/slack/agent'
import type { PreviewAgent } from '@duelwise/agents/src/agent-types'

export type ToWorker = { type: 'reset'; level: Level; seed: number; seat?: 0 | 1 } | { type: 'act'; id: number; obs: unknown }
/** `loaded` means the script and the search module are in. `failed` with id 0 is an agent that could not be built; any other id answers one `act`. */
export type FromWorker = { type: 'loaded' } | { type: 'ready' } | { type: 'acted'; id: number; action: number } | { type: 'failed'; id: number; message: string }

let agent: PreviewAgent | null = null
let ready: Promise<void> = Promise.resolve()

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  if (msg.type === 'reset') {
    ready = (async () => {
      agent?.dispose()
      agent = await createGameAgent(msg.level, { seat: msg.seat ?? 1 })
      agent.reset(msg.seed, msg.seat)
      ;(self as unknown as Worker).postMessage({ type: 'ready' } satisfies FromWorker)
    })().catch((err) => {
      agent = null
      ;(self as unknown as Worker).postMessage({ type: 'failed', id: 0, message: String(err) } satisfies FromWorker)
    })
    return
  }
  void ready.then(async () => {
    try {
      const [action] = await agent!.act(msg.obs)
      ;(self as unknown as Worker).postMessage({ type: 'acted', id: msg.id, action: action! } satisfies FromWorker)
    } catch (err) {
      ;(self as unknown as Worker).postMessage({ type: 'failed', id: msg.id, message: String(err) } satisfies FromWorker)
    }
  })
}

;(self as unknown as Worker).postMessage({ type: 'loaded' } satisfies FromWorker)
