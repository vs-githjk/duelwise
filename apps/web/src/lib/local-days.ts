export interface LocalDay {
  /** Local date, YYYY-MM-DD. */
  day: string
  matches: number
}

/** Matches per day for the 7 days ending today, oldest first, bucketed by the viewer's clock. `offsetMin` is minutes east of UTC. */
export function localDays(stamps: string[], now: Date, offsetMin: number): LocalDay[] {
  const key = (ms: number) => new Date(ms + offsetMin * 60_000).toISOString().slice(0, 10)
  const counts = new Map<string, number>()
  for (const s of stamps) counts.set(key(Date.parse(s)), (counts.get(key(Date.parse(s))) ?? 0) + 1)
  const out: LocalDay[] = []
  for (let i = 6; i >= 0; i--) {
    const day = key(now.getTime() - i * 86_400_000)
    out.push({ day, matches: counts.get(day) ?? 0 })
  }
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 21" from a local YYYY-MM-DD key, so a day label names its month. Empty for junk. */
export function dayLabel(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day)
  const month = m ? MONTHS[Number(m[1]) - 1] : undefined
  return m && month ? `${month} ${Number(m[2])}` : ''
}
