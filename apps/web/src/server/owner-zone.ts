/**
 * Time zone helpers for the owner pages. The zone name comes from the browser, so it is untrusted: `resolveZone` accepts only a
 * name Intl knows, and everything else becomes UTC (with `zoneFallback` true so the page can say so). Pure functions, no database.
 */

export interface ZoneInfo {
  /** The IANA zone every day and time on the page uses. */
  zone: string
  /** True when the asked-for zone was missing or not a real zone, so UTC is used instead. */
  zoneFallback: boolean
}

const NAME_MAX = 64

/** A zone Intl accepts, as written by Intl, or null. */
export function validZone(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > NAME_MAX || !/^[A-Za-z0-9_+\-/]+$/.test(raw)) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

export function resolveZone(raw: unknown): ZoneInfo {
  const zone = validZone(raw)
  return zone ? { zone, zoneFallback: false } : { zone: 'UTC', zoneFallback: true }
}

/** The browser's own zone name, or undefined where it cannot be read. */
export function browserZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function parts(d: Date, zone: string): Record<string, string> {
  let f = fmtCache.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    fmtCache.set(zone, f)
  }
  const out: Record<string, string> = {}
  for (const p of f.formatToParts(d)) out[p.type] = p.value
  return out
}

/** The calendar day (YYYY-MM-DD) an instant falls on in the zone. */
export function dayKeyIn(d: Date, zone: string): string {
  const p = parts(d, zone)
  return `${p.year!.padStart(4, '0')}-${p.month!.padStart(2, '0')}-${p.day!.padStart(2, '0')}`
}

/** A calendar day key moved by whole days. Pure date arithmetic, so a 23 or 25 hour day cannot skip or repeat a day. */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** HH:MM on the zone's wall clock. */
export function timeIn(iso: string, zone: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = parts(d, zone)
  return `${p.hour}:${p.minute}`
}

/** "Oct 21" for an instant, on the zone's calendar. */
export function shortDateIn(iso: string, zone: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = parts(d, zone)
  return `${MONTHS[Number(p.month) - 1]} ${p.day}`
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Eastern Time (EST)" at the instant, so the short name shows whether daylight saving is on. UTC is "UTC". */
export function zoneLabel(zone: string, at: Date = new Date()): string {
  if (zone === 'UTC') return 'UTC'
  try {
    const name = (opt: Intl.DateTimeFormatOptions['timeZoneName']) =>
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: opt }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value
    const long = name('longGeneric') ?? name('long')
    const short = name('short')
    return long && short && long !== short ? `${long} (${short})` : (long ?? short ?? zone)
  } catch {
    return zone
  }
}
