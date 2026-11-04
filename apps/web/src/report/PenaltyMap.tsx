import { DIVE_LABEL, ZONE_LABEL } from '../games/penalty/match'
import type { PenaltyKickRow, PenaltyView } from './types'

// The Twelve Yards kick map: the goal as the shooter sees it, nine spots, and a numbered marker for each of the player's kicks where it was aimed.
// A marker is shape plus a word, never colour alone: a filled disc is a goal, a ringed disc crossed through is a save, a dashed ring outside the frame
// went over the bar or wide. The list under the map gives every kick of the shootout, the opponent's too, for a screen reader and for the keeper half.

const W = 320
const H = 196
const GX = 36
const GY = 30
const CW = 82.67
const CH = 46
const GOAL_W = CW * 3
const GOAL_H = CH * 3

const OUTCOME_WORD: Record<PenaltyKickRow['outcome'], string> = { goal: 'goal', saved: 'saved', over: 'over the bar', wide: 'wide' }

/** Kicks that land at the same place share a key, so they can be spread sideways and none hides another. */
const placeKey = (k: PenaltyKickRow): number => k.zone * 10 + (k.outcome === 'over' ? 1 : k.outcome === 'wide' ? 2 : 0)

/** Marker radius: smaller when several kicks share a place, so they fit side by side. */
const radiusFor = (sharing: number): number => (sharing > 6 ? 8 : sharing > 1 ? 9 : 11)
/** Kicks to one place beyond this overlap rather than spill out of the picture (a player takes at most seventeen kicks, so twelve to one spot is not a real shootout). */
const MAX_SHARED = 12

/**
 * The centre of a kick's marker. Kicks to one spot sit in a small grid inside it (three to a row, so five or six stay within the cell, never over a post); a
 * kick that missed the frame sits just outside it: above the bar for over, beside the post it went past for wide, in a row or column that stays in the picture.
 */
export function place(k: PenaltyKickRow, nth0: number, sharing0: number): { x: number; y: number } {
  const sharing = Math.min(sharing0, MAX_SHARED)
  const nth = Math.min(nth0, MAX_SHARED - 1)
  const col = k.zone % 3
  const row = Math.floor(k.zone / 3)
  const cx = GX + col * CW + CW / 2
  const cy = GY + row * CH + CH / 2
  const step = 21
  if (k.outcome === 'over') return { x: cx + (nth - (sharing - 1) / 2) * Math.min(step, (CW - 14) / Math.max(1, sharing - 1)), y: GY - 14 }
  if (k.outcome === 'wide') {
    const along = (nth - (sharing - 1) / 2) * Math.min(step, (CH * 2) / Math.max(1, sharing))
    if (col === 0) return { x: GX - 18, y: cy + along }
    if (col === 2) return { x: GX + GOAL_W + 18, y: cy + along }
    return { x: cx + (nth - (sharing - 1) / 2) * Math.min(step, (CW - 14) / Math.max(1, sharing - 1)), y: GY + GOAL_H + 14 }
  }
  if (sharing <= 1) return { x: cx, y: cy }
  const perRow = Math.min(sharing > 6 ? 4 : 3, sharing)
  const rows = Math.ceil(sharing / perRow)
  const r = Math.floor(nth / perRow)
  const c = nth % perRow
  const inRow = r === rows - 1 ? sharing - r * perRow : perRow
  return { x: cx + (c - (inRow - 1) / 2) * (sharing > 6 ? 17 : step), y: cy + (r - (rows - 1) / 2) * (rows > 2 ? 15 : 19) }
}

function Marker({ k, x, y, r }: { k: PenaltyKickRow; x: number; y: number; r: number }) {
  return (
    <g data-testid={`pen-mark-${k.n}`} data-outcome={k.outcome}>
      {k.outcome === 'goal' ? <circle cx={x} cy={y} r={r} fill="var(--action)" stroke="var(--goal-post)" strokeWidth={2} /> : null}
      {k.outcome === 'saved' ? (
        <>
          <circle cx={x} cy={y} r={r} fill="var(--surface)" stroke="var(--ink)" strokeWidth={2.4} />
          <circle cx={x} cy={y} r={r - 3.6} fill="none" stroke="var(--ink)" strokeWidth={1} />
        </>
      ) : null}
      {k.outcome === 'over' || k.outcome === 'wide' ? <circle cx={x} cy={y} r={r} fill="var(--surface)" stroke="var(--ink)" strokeWidth={2} strokeDasharray="3 3" /> : null}
      <text x={x} y={y + 4.5} textAnchor="middle" fontSize={r > 10 ? 13 : 11} fontWeight={700} fill={k.outcome === 'goal' ? 'var(--action-ink)' : 'var(--ink)'} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {k.n}
      </text>
    </g>
  )
}

export function PenaltyMap({ view, viewer = 'owner', opponent = 'The AI' }: { view: PenaltyView; viewer?: 'owner' | 'public'; opponent?: string }) {
  const you = viewer === 'owner' ? 'You' : 'The player'
  const yours = viewer === 'owner' ? 'Your' : "The player's"
  const mine = view.kicks.filter((k) => k.byMe)
  const seen = new Map<number, number>()
  const sharing = new Map<number, number>()
  for (const k of mine) sharing.set(placeKey(k), (sharing.get(placeKey(k)) ?? 0) + 1)
  const scored = mine.filter((k) => k.outcome === 'goal').length
  const saved = mine.filter((k) => k.outcome === 'saved').length
  const off = mine.length - scored - saved
  const aria = `${yours} kick map. ${mine.map((k) => `Kick ${k.n}, ${ZONE_LABEL[k.zone]!.toLowerCase()}, ${OUTCOME_WORD[k.outcome]}`).join('. ')}.`
  return (
    <div className="grid gap-4" data-testid="penalty-final">
      <div className="mx-auto w-full max-w-md overflow-hidden rounded-control border border-line" style={{ background: 'var(--pitch)' }}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={aria} className="block w-full" data-testid="penalty-final-map">
          {/* The grass, with the stripe the game draws. */}
          <rect x={0} y={0} width={W} height={H} fill="var(--pitch)" />
          <rect x={0} y={GY + GOAL_H + 26} width={W} height={H - GY - GOAL_H - 26} fill="var(--pitch-stripe)" />
          {/* The net and the nine spots. */}
          <rect x={GX} y={GY} width={GOAL_W} height={GOAL_H} fill="rgba(255,255,255,0.12)" />
          {[1, 2].map((i) => (
            <g key={i} stroke="rgba(255,255,255,0.45)" strokeWidth={1} strokeDasharray="2 4">
              <line x1={GX + i * CW} y1={GY} x2={GX + i * CW} y2={GY + GOAL_H} />
              <line x1={GX} y1={GY + i * CH} x2={GX + GOAL_W} y2={GY + i * CH} />
            </g>
          ))}
          {/* The frame. */}
          <path d={`M ${GX} ${GY + GOAL_H} V ${GY} H ${GX + GOAL_W} V ${GY + GOAL_H}`} fill="none" stroke="var(--goal-post)" strokeWidth={5} strokeLinejoin="round" />
          <text x={W / 2} y={H - 10} textAnchor="middle" fontSize={11} fill="rgba(255,255,255,0.85)">
            As the shooter sees the goal
          </text>
          {mine.map((k) => {
            const key = placeKey(k)
            const nth = seen.get(key) ?? 0
            seen.set(key, nth + 1)
            const p = place(k, nth, sharing.get(key) ?? 1)
            return <Marker key={k.n} k={k} x={p.x} y={p.y} r={radiusFor(sharing.get(key) ?? 1)} />
          })}
        </svg>
      </div>
      <p className="text-center text-sm text-muted" data-testid="penalty-final-legend">
        {yours} kicks, in order: a blue disc is a goal ({scored}), a ringed disc is a save ({saved}), a dashed ring is over the bar or wide ({off}).
      </p>
      <div data-testid="penalty-kicks">
        <h3 className="mb-1 text-sm font-semibold text-muted">Every kick</h3>
        <ol className="grid gap-1 text-sm">
          {view.kicks.map((k) => (
            <li key={k.n} className="flex flex-wrap items-baseline gap-x-2 rounded-control border border-line px-2 py-1" data-by={k.byMe ? 'player' : 'ai'} data-outcome={k.outcome}>
              <span className="font-mono tabular text-muted">{k.n}</span>
              <span className="font-semibold">{k.byMe ? `${you} shot ${ZONE_LABEL[k.zone]!.toLowerCase()}` : `${opponent} shot ${ZONE_LABEL[k.zone]!.toLowerCase()}`}</span>
              <span className="text-muted">{k.byMe ? `${opponent}: ${DIVE_LABEL[k.dive]!.toLowerCase()}` : `${you}: ${DIVE_LABEL[k.dive]!.toLowerCase()}`}</span>
              <span className="ml-auto font-semibold">{OUTCOME_WORD[k.outcome][0]!.toUpperCase() + OUTCOME_WORD[k.outcome].slice(1)}</span>
              {k.sudden ? <span className="sr-only">, sudden death</span> : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
