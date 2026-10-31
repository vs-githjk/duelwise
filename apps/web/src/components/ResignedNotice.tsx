import { useEffect, useState } from 'react'
import type { GameId } from '@duelwise/core/src/product'
import { readResignedOnLeave } from '../lib/integrity'

/** Shown on setup when the last counted match of this game was resigned because the page was reloaded or closed mid-match. Gone once the next match starts. */
export function ResignedNotice({ game }: { game: GameId }) {
  const [shown, setShown] = useState(false)
  useEffect(() => setShown(readResignedOnLeave(game)), [game])
  if (!shown) return null
  return (
    <p className="rounded-control bg-warn-soft px-3 py-2 text-sm text-warn-ink" role="status" data-testid="resigned-notice">
      Your last match was resigned when the page reloaded.
    </p>
  )
}
