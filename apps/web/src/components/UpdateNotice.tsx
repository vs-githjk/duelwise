import { useEffect, useState } from 'react'
import { isMatchActive, subscribeMatchActive } from '../lib/match-active'
import { forgetKeptPages, reloadForStaleChunk, UPDATE_READY_EVENT } from '../lib/stale-chunk'

/**
 * Shown when a new version went live while a match is running. It never reloads under the player: it waits for the match to end
 * (or a tap on Reload) and then reloads once. If the page may not reload by itself (see reloadForStaleChunk) the notice stays as a button.
 */
export function UpdateNotice() {
  const [ready, setReady] = useState(false)
  const [active, setActive] = useState(isMatchActive())

  useEffect(() => {
    const onReady = () => setReady(true)
    window.addEventListener(UPDATE_READY_EVENT, onReady)
    const unsubscribe = subscribeMatchActive(() => setActive(isMatchActive()))
    return () => {
      window.removeEventListener(UPDATE_READY_EVENT, onReady)
      unsubscribe()
    }
  }, [])

  // The match ended (or was left): now the update may load.
  useEffect(() => {
    if (ready && !active) void reloadForStaleChunk()
  }, [ready, active])

  if (!ready) return null
  return (
    <div role="status" data-testid="update-ready-notice" className="fixed bottom-3 left-3 z-50 flex max-w-[calc(100vw-1.5rem)] items-center gap-3 rounded-control border border-line bg-surface px-4 py-3 text-sm shadow-lg">
      <span>{active ? 'Duelwise updated. Reload after this match.' : 'Duelwise updated.'}</span>
      <button
        type="button"
        className="inline-flex min-h-11 items-center rounded-control bg-action px-4 font-semibold text-action-ink"
        onClick={() => void forgetKeptPages().then(() => window.location.reload())}
      >
        Reload
      </button>
    </div>
  )
}
