/**
 * A short per-database cache for aggregates that every landing load asks for (the public board, the opponent records).
 * Both scan the match store, so one read per window serves everybody; the numbers may lag by up to the TTL. A failed load is not cached.
 */
const caches = new WeakMap<object, Map<string, { at: number; value: unknown; pending?: Promise<unknown> }>>()

export const AGGREGATE_TTL_MS = 60_000

export async function cachedFor<T>(db: object, key: string, nowMs: number, ttlMs: number, load: () => Promise<T>): Promise<T> {
  let byKey = caches.get(db)
  if (!byKey) caches.set(db, (byKey = new Map()))
  const hit = byKey.get(key)
  if (hit && hit.pending) return hit.pending as Promise<T>
  if (hit && nowMs >= hit.at && nowMs - hit.at < ttlMs) return hit.value as T
  // Share the in-flight load so N callers after expiry run one scan; a failed load clears the slot and is not cached.
  const pending = load().then(
    (value) => {
      byKey.set(key, { at: nowMs, value })
      return value
    },
    (err) => {
      if (byKey.get(key)?.pending === pending) byKey.delete(key)
      throw err
    },
  )
  byKey.set(key, { at: hit?.at ?? -Infinity, value: hit?.value, pending })
  return pending
}
