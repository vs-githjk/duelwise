import { postFinishDetailed, type FinishAnswer } from './integrity'
import { transact, UPLOADS } from './offline-db'
import { ownsTicket, rememberedViewer, type TicketOwner } from './tickets'

export interface QueuedUpload { matchId: string; bytes: Uint8Array; attempts: number; nextAttempt: number; createdAt?: number; owner?: TicketOwner }
export interface UploadStore {
  put(item: QueuedUpload): Promise<void>
  list(): Promise<QueuedUpload[]>
  remove(id: string): Promise<void>
}

/** What the server did with a queued record: `counted` only when it answered 200 and the match was valid. */
export interface UploadOutcome { matchId: string; counted: boolean; reason?: string }

/** Fired on window when queued records were settled by the server; `detail.matchIds` names them and `detail.outcomes` says whether each counted. */
export const QUEUE_EVENT = 'duelwise:queue-settled'

/** A record the server keeps refusing as "not your match" is dropped once its ticket could no longer be used anyway. */
export const REFUSED_KEEP_MS = 16 * 24 * 60 * 60 * 1000

export const uploadStore: UploadStore = {
  async put(item) { await transact(UPLOADS, 'readwrite', (s) => s.put(item)) },
  list: () => transact(UPLOADS, 'readonly', (s) => s.getAll()),
  async remove(id) { await transact(UPLOADS, 'readwrite', (s) => s.delete(id)) },
}
export async function enqueueUpload(matchId: string, bytes: Uint8Array, store: UploadStore = uploadStore, owner?: TicketOwner, now = Date.now()): Promise<void> {
  // Repeated saves do not create duplicate uploads.
  await store.put({ matchId, bytes, attempts: 0, nextAttempt: 0, createdAt: now, ...(owner ? { owner } : {}) })
}

/** Why the server did not count a record it answered, in words for the player. */
export function reasonFor(answer: FinishAnswer): string {
  if (answer.status === 410) return 'its offline slot expired before it was sent'
  if (answer.status === 409) return answer.reason ? `the server already settled it (${answer.reason})` : 'the server already has a result for it'
  if (answer.status === 404) return 'the server has no record of this match'
  if (answer.status === 403) return 'it was played by another player on this device'
  return answer.reason ?? 'the server did not accept it'
}

let draining: Promise<number> | undefined
export function drainUploads(
  store: UploadStore = uploadStore,
  send: (bytes: Uint8Array) => Promise<number | FinishAnswer> = postFinishDetailed,
  now = Date.now(),
  viewer: TicketOwner | null = rememberedViewer(),
): Promise<number> {
  if (draining) return draining
  draining = (async () => {
    let settled = 0
    const outcomes: UploadOutcome[] = []
    for (const item of await store.list()) {
      if (item.nextAttempt > now) continue
      // A record made by another player on this device waits for them (the server would refuse it) until its ticket could not count any more.
      if (viewer && item.owner && !ownsTicket(item.owner, viewer)) {
        if (item.createdAt !== undefined && now - item.createdAt > REFUSED_KEEP_MS) await store.remove(item.matchId)
        continue
      }
      let answer: FinishAnswer = { status: 0 }
      try {
        const r = await send(item.bytes)
        answer = typeof r === 'number' ? { status: r } : r
      } catch { /* retry later */ }
      const status = answer.status
      const refused = status === 403 && item.createdAt !== undefined && now - item.createdAt > REFUSED_KEEP_MS
      if ((status >= 200 && status < 500 && status !== 401 && status !== 403 && status !== 429) || refused) {
        await store.remove(item.matchId)
        settled++
        const counted = status === 200 ? answer.valid !== false : status === 409 && answer.valid === true
        outcomes.push({ matchId: item.matchId, counted, ...(counted ? {} : { reason: status === 200 ? answer.reason ?? 'the server could not verify it' : reasonFor(answer) }) })
      } else {
        const attempts = item.attempts + 1
        await store.put({ ...item, attempts, nextAttempt: now + Math.min(60 * 60_000, 1000 * 2 ** Math.min(attempts, 12)) })
      }
    }
    if (outcomes.length > 0 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(QUEUE_EVENT, { detail: { matchIds: outcomes.map((o) => o.matchId), outcomes } }))
    return settled
  })().finally(() => { draining = undefined })
  return draining
}

/** How many finished records are waiting for the server. */
export async function queuedCount(store: UploadStore = uploadStore): Promise<number> {
  try { return (await store.list()).length } catch { return 0 }
}
