import { useEffect, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import type { CardData } from '../server/landing-fns'
import type { GameWeek } from '../server/landing'
import { registryFor } from '../lib/registries'
import { LEVEL_LABEL } from '../lib/level-info'
import { Avatar } from '../personas/Avatar'
import { personaFor } from '../personas'
import { GameTile } from './GameTile'
import { MATCH_NOUN } from '../lib/tile-copy'
import { promotionLine } from '../lib/copy'
import { PreviewBadge } from './PreviewBadge'

const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']

/** The levels of this game that have measured strength, read from the registry; the rest show dimmed. */
function publishedLevels(game: GameId): Set<Level> {
  const reg = registryFor(game)
  return new Set(LEVELS.filter((l) => reg?.levels[l] && reg.measured[l]))
}

export interface GameCardProps {
  card: CardData
  week: GameWeek | undefined
  playable: boolean
}

/** One game: key art, the status the registry and the page folder give it, and this week's human record from the database. */
export function GameCard({ card, week, playable }: GameCardProps) {
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      const index = Array.from(node.parentElement?.children ?? []).indexOf(node)
      node.animate([{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 500, delay: Math.max(0, index) * 65, easing: 'ease-out', fill: 'backwards' })
      observer.disconnect()
    }, { threshold: 0.1 })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const id = card.game
  const cfg = PRODUCT.games[id]
  const published = publishedLevels(id)
  const firstLevel = LEVELS.find((l) => published.has(l)) ?? 'easy'
  const first = personaFor(firstLevel)
  return (
    <li
      ref={ref}
      onPointerMove={(event) => {
        if (event.pointerType !== 'mouse' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
        const bounds = event.currentTarget.getBoundingClientRect()
        const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
        const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
        event.currentTarget.style.setProperty('--sheen-x', `${x * 100}%`)
        event.currentTarget.style.setProperty('--sheen-y', `${y * 100}%`)
      }}
      className="game-card group grid overflow-hidden rounded-card border border-line bg-surface shadow-card"
      data-testid={`game-card-${id}`}
    >
      <div className="game-card-art relative aspect-[16/9] overflow-hidden bg-surface-2">
        <GameTile game={id} className="size-full transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none" />
      </div>
      <div className="grid gap-2 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="font-display text-display-sm">{cfg.displayName}</h3>
              {card.learnsFromHumans && <span className="rounded-full bg-good-soft px-2.5 py-0.5 text-xs font-semibold text-good-ink" data-testid={`learns-chip-${id}`}>Learns from you</span>}
            </div>
            <p className="text-sm text-muted" data-testid={`card-note-${id}`}>{card.note}</p>
            {promotionLine(card) ? <p className="text-xs text-muted" data-testid={`card-promotion-${id}`}>{promotionLine(card)}</p> : null}
          </div>
          {card.measured === 0 && <PreviewBadge label="Practice" />}
        </div>
        <div className="flex items-center gap-3 text-sm text-muted" data-testid={`card-cast-${id}`}>
          <span>
            Start with <b className="font-semibold text-ink">{first.name}</b>
          </span>
          <span className="av-stack ml-auto" role="img" aria-label={`${LEVELS.map((l) => `${personaFor(l).name} (${LEVEL_LABEL[l]})${published.has(l) ? '' : ', Practice'}`).join(', ')}`}>
            {LEVELS.map((l) => (
              <Avatar key={l} level={l} size={28} decorative dim={!published.has(l)} />
            ))}
          </span>
        </div>
        <dl className="grid gap-0.5 text-sm text-muted">
          <div className="flex justify-between gap-3">
            <dt>Strength</dt>
            <dd className="text-ink" data-testid={`card-levels-${id}`}>
              {card.measured} of 4 levels measured
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>This week</dt>
            <dd className="text-ink" data-testid={`card-week-${id}`}>
              {week && week.games > 0 ? `${week.games.toLocaleString('en-US')} ${MATCH_NOUN[id]}, humans won ${week.wins.toLocaleString('en-US')}` : 'No matches yet'}
            </dd>
          </div>
        </dl>
        <div className="flex items-center gap-2 pt-1">
          {playable ? (
            <Link to="/play/$game" params={{ game: cfg.slug }} className="inline-flex min-h-11 items-center rounded-control bg-action px-4 font-semibold text-action-ink">
              Play {first.name}
            </Link>
          ) : (
            <span className="inline-flex min-h-11 items-center text-sm text-muted">In development</span>
          )}
          <Link to="/agents/$game" params={{ game: cfg.slug }} className="inline-flex min-h-11 items-center px-2 text-sm text-muted hover:text-ink">
            The AI
          </Link>
        </div>
      </div>
    </li>
  )
}
