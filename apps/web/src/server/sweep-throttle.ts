/**
 * Lets a housekeeping task run at most once per interval per database handle (per server instance), however many requests
 * ask for it. The abandon sweep used to run on every start, finish and leaderboard load; a match is only abandoned after a
 * game's maximum length plus 15 minutes, so a few minutes of lag changes nothing a player can see. A caller that arrives
 * while the task is running waits for that run instead of starting a second. A failed run still counts as a run, so a
 * database that is down is not hit again by every request.
 */
const state = new WeakMap<object, { at: number; running?: Promise<void> }>()

export const SWEEP_INTERVAL_MS = 5 * 60_000

export async function runThrottled(key: object, nowMs: number, task: () => Promise<void>, intervalMs: number = SWEEP_INTERVAL_MS): Promise<void> {
  const s = state.get(key)
  if (s?.running) return s.running
  if (s && nowMs >= s.at && nowMs - s.at < intervalMs) return
  const entry: { at: number; running?: Promise<void> } = { at: nowMs }
  entry.running = task().finally(() => {
    delete entry.running
  })
  state.set(key, entry)
  return entry.running
}
