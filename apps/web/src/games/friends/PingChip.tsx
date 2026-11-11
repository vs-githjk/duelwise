/**
 * The small ping chip shown during a two-device realtime match (D9, taken at the plan's recommendation): green under 60 ms, amber up to 120,
 * red above. The number and the word say it too, so colour is never the only signal. Nothing is shown until the first round trip is known.
 */
export type PingTone = 'good' | 'warn' | 'bad'

export function pingTone(ms: number): PingTone {
  return ms < 60 ? 'good' : ms <= 120 ? 'warn' : 'bad'
}

const WORD: Record<PingTone, string> = { good: 'Good link', warn: 'Fair link', bad: 'Slow link' }
const TONE: Record<PingTone, string> = {
  good: 'bg-good-soft text-good-ink',
  warn: 'bg-warn-soft text-warn-ink',
  bad: 'bg-bad-soft text-bad-ink',
}

export function PingChip({ rttMs, className = '' }: { rttMs: number; className?: string }) {
  if (!(rttMs > 0)) return null
  const tone = pingTone(rttMs)
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-xs ${TONE[tone]} ${className}`}
      data-testid="ping-chip"
      data-tone={tone}
      role="status"
      aria-label={`${WORD[tone]}, ${Math.round(rttMs)} milliseconds`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {Math.round(rttMs)} ms
    </span>
  )
}
