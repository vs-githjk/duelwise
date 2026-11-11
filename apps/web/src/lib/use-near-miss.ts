import { useEffect, useState } from 'react'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import type { NearMiss } from '../report/near-miss'

/**
 * The near miss of a finished record for the result screen, replayed from the record alone. The replay runs after the panel has painted
 * (Four's solver can take a second) and in its own chunk, so the verdict is never held back; until it answers, and for any match that was
 * not close, there is nothing to show.
 */
export function useNearMiss(record: MatchRecordV1 | null | undefined): NearMiss | null {
  const [nm, setNm] = useState<NearMiss | null>(null)
  useEffect(() => {
    setNm(null)
    if (!record) return
    let alive = true
    const timer = setTimeout(() => {
      void import('../report/moments')
        .then(({ nearMissFor }) => { if (alive) setNm(nearMissFor(record, undefined, { surface: 'result' })) })
        .catch(() => {})
    }, 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [record])
  return nm
}
