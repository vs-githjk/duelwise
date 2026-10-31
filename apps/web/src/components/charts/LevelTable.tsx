import type { LevelSummary } from '../../server/stats'
import { cn } from '../../lib/cn'
import { LEVEL_NAME, measuredText, playerMetric } from './format'

/** One row per level: measured strength from the registry, or "in training" with the reason. */
export function LevelTable({ levels, realtime }: { levels: LevelSummary[]; realtime: boolean }) {
  return (
    <div data-testid="level-table" className="min-w-0">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Levels, measured strength and limits</caption>
        <thead className="hidden sm:table-header-group">
          <tr className="border-b border-line text-muted">
            <th scope="col" className="py-2 pr-3 font-semibold">Level</th>
            <th scope="col" className="py-2 pr-3 font-semibold">Measured</th>
            {realtime ? null : <th scope="col" className="py-2 pr-3 text-right font-semibold">Site Elo</th>}
            {realtime ? <th scope="col" className="py-2 pr-3 text-right font-semibold">Reaction</th> : null}
            {realtime ? <th scope="col" className="py-2 text-right font-semibold">Action cap</th> : null}
          </tr>
        </thead>
        <tbody>
          {levels.map((l) => (
            <tr key={l.level} className="block border-b border-line py-3 sm:table-row sm:py-0 align-top" data-testid={`level-row-${l.level}`} data-state={l.state}>
              <th scope="row" className="block py-1 font-semibold sm:table-cell sm:py-2.5 sm:pr-3">{LEVEL_NAME[l.level]}</th>
              {l.state === 'measured' ? (
                <>
                  <td className="block py-1 font-mono tabular sm:table-cell sm:py-2.5 sm:pr-3">
                    {measuredText(l.metric!, l.value!)} <span className="text-muted">({measuredText(l.metric!, l.ci95![0])} to {measuredText(l.metric!, l.ci95![1])}, {l.n} {/guess/i.test(l.metric!) ? 'words' : 'games'})</span>
                    <span className="block font-sans text-xs text-muted">{playerMetric(l.metric!)}</span>
                    {l.plain ? <span className="block font-sans text-xs text-ink" data-testid={`plain-${l.level}`}>{l.plain}</span> : null}
                  </td>
                  {realtime ? null : <td className="block py-1 font-mono tabular sm:table-cell sm:py-2.5 sm:pr-3 sm:text-right" data-testid={`site-elo-${l.level}`}>{Math.round(l.siteElo!)}</td>}
                </>
              ) : (
                <td className="block py-1 text-muted sm:table-cell sm:py-2.5 sm:pr-3" colSpan={realtime ? 1 : 2} data-testid={`in-training-${l.level}`}>
                  <span className="font-semibold text-warn-ink">In training</span>
                  <span className="block text-xs">{l.reason}</span>
                </td>
              )}
              {realtime ? (
                <td className={cn('block py-1 font-mono tabular sm:table-cell sm:py-2.5 sm:pr-3 sm:text-right', l.reactionFrames === undefined && 'text-muted')}>
                  {l.reactionFrames === undefined ? 'n/a' : `${Math.round(l.reactionFrames * 1000 / 60)} ms (${l.reactionFrames} frames)`}
                </td>
              ) : null}
              {realtime ? (
                <td className={cn('block py-1 font-mono tabular sm:table-cell sm:py-2.5 sm:text-right', l.apmCap == null && 'text-muted')}>
                  {l.apmCap === undefined ? 'n/a' : l.apmCap === null ? 'no cap' : `${l.apmCap} actions per minute`}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
