import { useMemo } from 'react'
import { buildReportBody } from '../report/build'
import { publicBody } from '../report/copy'
import { ReportPageView } from '../report/ReportPage'
import { playRandom } from '../report/testing'
import type { ReportView } from '../server/report'

/**
 * Dev-only: the report page on fixture matches played on the real cores, for design checks.
 * /dev/report?scenario=chess|four|word|slack and &mode=public|owner.
 */
export default function ReportDevView() {
  const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
  const scenario = (q.get('scenario') ?? 'chess') as 'chess' | 'four' | 'word' | 'slack'
  const mode = q.get('mode') === 'public' ? 'public' : 'owner'
  const view = useMemo<ReportView>(() => {
    const rec = playRandom(scenario, scenario === 'chess' ? 12 : 4, 0, 'medium')
    const full = buildReportBody(rec)
    const body = mode === 'public' ? publicBody(full) : full
    return {
      id: 'fixture',
      mode,
      status: 'ready',
      game: scenario,
      level: 'medium',
      day: '2026-10-22',
      body,
      playerName: null,
      owner: mode === 'owner' ? { rating: { before: 1012, after: 1041, provisional: false }, signedIn: true, learning: { state: 'stored' }, linkPublic: true, showName: false, record: { wins: 3, losses: 1, draws: 1, recent: ['win', 'loss', 'win', 'draw', 'win'] } } : null,
    }
  }, [scenario, mode])
  return <ReportPageView page={{ view, origin: 'http://localhost' }} />
}
