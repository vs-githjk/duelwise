import { DurableObject } from 'cloudflare:workers'
import { callerIsEmpty, emptyCaller, pruneCaller, releaseRoom, reserveRoom, type CallerState } from './limits'

const KEY = 'caller'
const DAY = 24 * 60 * 60_000

/**
 * One object per caller reference: how many rooms it holds open and how many it created in the last 24 hours.
 * Holds a few hundred bytes, no game data. Deletes itself a day after its last room.
 */
export class LimiterDO extends DurableObject<unknown> {
  async reserve(code: string, now: number): Promise<'ok' | 'too-many-open' | 'daily'> {
    const s = (await this.ctx.storage.get<CallerState>(KEY)) ?? emptyCaller()
    const r = reserveRoom(s, code, now)
    await this.ctx.storage.put(KEY, r.state)
    await this.ctx.storage.setAlarm(now + DAY)
    return r.verdict
  }

  async release(code: string): Promise<void> {
    const s = await this.ctx.storage.get<CallerState>(KEY)
    if (s) await this.ctx.storage.put(KEY, releaseRoom(s, code))
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    const s = pruneCaller((await this.ctx.storage.get<CallerState>(KEY)) ?? emptyCaller(), now)
    if (callerIsEmpty(s)) await this.ctx.storage.deleteAll()
    else {
      await this.ctx.storage.put(KEY, s)
      await this.ctx.storage.setAlarm(now + DAY)
    }
  }
}
