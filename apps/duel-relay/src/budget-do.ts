import { DurableObject } from 'cloudflare:workers'
import { addUsage, reserveBudget, type BudgetState, type RealtimeGame } from './limits'

const KEY = 'day'

/**
 * D6: one object for the whole relay, counting the estimated Durable Object requests that realtime matches may cost today and
 * the realtime minutes each caller has started. One call (one request, one row) per match start. Holds a few KB.
 */
export class BudgetDO extends DurableObject<unknown> {
  async reserve(game: RealtimeGame, refs: string[], now: number): Promise<'ok' | 'spent' | 'minutes'> {
    const r = reserveBudget(await this.ctx.storage.get<BudgetState>(KEY), now, game, refs)
    if (r.verdict === 'ok') await this.ctx.storage.put(KEY, r.state)
    return r.verdict
  }

  /** At match end: the requests the match really used beyond its charged estimate. One call and one row, only when there is an excess. */
  async settle(extraRequests: number, now: number): Promise<void> {
    await this.ctx.storage.put(KEY, addUsage(await this.ctx.storage.get<BudgetState>(KEY), now, extraRequests))
  }
}
