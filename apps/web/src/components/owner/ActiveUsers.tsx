import type { ActiveUsers } from '../../server/admin-owner'
import { getAdminActive } from '../../server/admin-fns'
import { shortDate } from '../charts/format'
import { zoneLabel } from '../../server/owner-zone'
import { useLoad } from './Admin'
import { Legend, SplitTile, StackBar } from './Breakdown'
import { Card } from './Card'

const REFRESH_MS = 60_000

/** Active players from finished matches (guests and accounts), human first, with the owner, test and total beside it and a 30-day daily chart. */
export function ActiveCards({ zone }: { zone: string }) {
  const { data, error, retry } = useLoad<ActiveUsers>(() => getAdminActive({ data: { tz: zone } }), [zone], REFRESH_MS)
  const first = data?.perDay[0]?.day
  const last = data?.perDay[data.perDay.length - 1]?.day
  const max = Math.max(1, ...(data?.perDay.map((d) => d.total) ?? [1]))
  return (
    <Card title="Active players" note={`finished matches, guests and accounts, days on ${zoneLabel(data?.zone ?? zone)} time`} testId="owner-active">
      {error ? (
        <p role="alert" className="rounded-control bg-warn-soft p-3 text-sm text-warn-ink">
          Active players did not load. <button type="button" className="font-semibold underline" onClick={retry}>Try again</button>
        </p>
      ) : null}
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <SplitTile label="DAU" s={data.dau} hint="today" testId="active-dau" />
            <SplitTile label="WAU" s={data.wau} hint="7 days" testId="active-wau" />
            <SplitTile label="MAU" s={data.mau} hint="30 days" testId="active-mau" />
            <SplitTile label="Returning" s={data.returning30} hint="2+ days in 30" testId="active-returning" />
          </div>
          <p className="text-xs text-muted" data-testid="active-returning7">Returning in 7 days: Human {data.returning7.human} · Owner {data.returning7.owner} · Test {data.returning7.test} · Total {data.returning7.total}</p>
          <div className="grid gap-1" data-testid="active-spark" role="img" aria-label={`Daily active players, last 30 days: ${data.perDay.map((d) => `${shortDate(d.day)} ${d.human} human of ${d.total}`).join(', ')}`}>
            <div className="flex h-16 items-end gap-0.5">
              {data.perDay.map((d) => (
                <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${shortDate(d.day)}: ${d.human} human, ${d.owner} owner, ${d.test} test`}>
                  <StackBar d={d} max={max} h={60} />
                </div>
              ))}
            </div>
            <p aria-hidden className="flex justify-between text-xs text-muted">
              <span>{first ? shortDate(first) : ''}</span>
              <span>daily active players</span>
              <span>{last ? shortDate(last) : ''}</span>
            </p>
            <Legend />
          </div>
        </>
      ) : error ? null : (
        <div aria-busy="true" className="h-32 rounded-control bg-neutral-soft" data-testid="active-loading" />
      )}
    </Card>
  )
}
