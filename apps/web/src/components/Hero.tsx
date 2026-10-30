import { Link } from '@tanstack/react-router'
import type { Level } from '@duelwise/core/src/product'
import { LEVELS, LEVEL_LABEL } from '../lib/level-info'
import { cn } from '../lib/cn'
import { Avatar } from '../personas/Avatar'
import { personaFor } from '../personas'
import type { OpponentRecord } from '../server/board'

const n = (v: number) => v.toLocaleString('en-US')

/** One opponent on the fight card: portrait, name, level, and its real record against people (hidden until someone has played it). */
export function FighterCard({ level, record }: { level: Level; record: OpponentRecord | undefined }) {
  const p = personaFor(level)
  const played = record !== undefined && record.wins + record.losses > 0
  return (
    <li
      className={cn('relative grid justify-items-center gap-1 rounded-card border bg-surface px-3 pb-4 pt-5 text-center shadow-card', level === 'champion' ? 'border-warn' : 'border-line')}
      data-testid={`fighter-${level}`}
    >
      {level === 'champion' ? (
        <span className="absolute -top-2.5 rounded-full bg-warn px-2.5 py-0.5 font-mono text-xs font-medium uppercase tracking-widest text-surface">Champion</span>
      ) : null}
      <Avatar level={level} size={96} decorative className="max-sm:!size-16" />
      <b className="font-display text-display-sm">{p.name}</b>
      <span className="font-mono text-xs uppercase tracking-widest text-muted">{LEVEL_LABEL[level]}</span>
      {played ? (
        <span className="tabular font-mono text-xs text-muted" data-testid={`fighter-record-${level}`} aria-label={`${p.name} has won ${n(record.wins)} and lost ${n(record.losses)} against people in the last 30 days`}>
          <b className="font-medium text-ink">{n(record.wins)}</b> W <b className="font-medium text-ink">{n(record.losses)}</b> L
        </span>
      ) : (
        <span className="font-mono text-xs text-muted" data-testid={`fighter-record-${level}`}>No matches yet</span>
      )}
    </li>
  )
}

/** The fight card: the challenge, the four opponents, and one way in. "Step in" opens the pick-your-game grid, never a single game. */
export function Hero({ records }: { records: OpponentRecord[] }) {
  const first = personaFor('easy').name
  return (
    <section className="hero-scene -mx-4 px-4 pb-10 pt-10 text-center md:-mx-10 md:px-10 md:pb-16 md:pt-14" aria-label="Introduction">
      <p className="hero-kicker font-mono text-xs uppercase tracking-[.16em] text-peach-deep">Six games. Four opponents. No account.</p>
      <h1 className="hero-title mx-auto mt-4 max-w-[16ch] font-display text-[clamp(44px,8.6vw,118px)] font-bold leading-[.94] tracking-[-.03em] [font-variation-settings:'opsz'_144] sm:max-w-none">
        Can you beat <em className="font-black italic text-action">my agents?</em>
      </h1>
      <ul className="hero-cards mx-auto mt-8 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4" aria-label="The four opponents">
        {LEVELS.map((l) => (
          <FighterCard key={l} level={l} record={records.find((r) => r.level === l)} />
        ))}
      </ul>
      <div className="mt-8 grid justify-items-center gap-2">
        <Link to="/play" className="inline-flex min-h-12 items-center rounded-full bg-action px-9 text-lg font-semibold text-action-ink shadow-card" data-testid="step-in">
          Step in
        </Link>
        <p className="text-sm text-muted">No account needed. Your first opponent is {first}. Records are wins and losses against people, last 30 days.</p>
      </div>
    </section>
  )
}
