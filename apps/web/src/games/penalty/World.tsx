import type { CSSProperties } from 'react'
import type { Kick, Zone } from '@duelwise/core/src/games/penalty/core'
import { DIVE_LABEL, ZONE_LABEL, SPOT, cellCentre, diveOf, flightOf, type Role } from './match'

// The drawn parts of the Twelve Yards scene, shared by the page against the AI (index.tsx) and the friend page on one device (friends/FriendPenalty.tsx), so
// both play on exactly the same goal, keeper and ball. Nothing here knows who is playing: it draws the picks it is handed.

export const ZONES: Zone[] = [0, 1, 2, 3, 4, 5, 6, 7, 8]
export const DIVES = [
  { pick: 0, col: 0, row: 0 },
  { pick: 1, col: 0, row: 1 },
  { pick: 2, col: 1, row: 'stay' },
  { pick: 3, col: 2, row: 0 },
  { pick: 4, col: 2, row: 1 },
] as const

/** Ball and keeper targets as scene variables. Set only after the commit, so the page holds nothing of either pick before it. */
export function reveal(k: Kick): CSSProperties {
  const f = flightOf(k)
  const d = diveOf(k)
  return {
    '--bx': f.bx,
    '--by': f.by,
    '--curl': f.curl,
    '--dx': f.dx,
    '--dy': f.dy,
    '--kx': d.kx,
    '--ky': d.ky,
    '--kr': `${d.kr}deg`,
    '--kf': d.fall,
  } as CSSProperties
}

/** Where a pick sits on the goal, in percent of the scene: the shot's cell, or the middle of the dive's half of the goal. */
export function shotSpot(zone: number): { left: string; top: string } {
  const c = cellCentre(zone)
  return { left: `${(c.x / 328) * 100}%`, top: `${(c.y / 300) * 100}%` }
}
const pct = (left: number, top: number) => ({ left: `${left}%`, top: `${top}%` })
// Below the zone's own label (the picked dive's name is centred in its zone), so the tag never covers it.
export const DIVE_SPOT = [pct(9, 28), pct(9, 52), pct(41, 8), pct(72, 28), pct(72, 52)]
// The opponent keeper's tag has to stay off the keeper and inside the frame: towards the middle of the goal, away from the side the keeper dived to, above a low dive and under a high one.
export const KEEPER_TAG = [pct(34, 47), pct(34, 31), pct(41, 8), pct(54, 47), pct(54, 31)]

/** A tag beside a shot's cell, kept inside the frame. */
export function tagAt(zone: number): { left: string; top: string } {
  const c = cellCentre(zone)
  return { left: `${(((zone % 3 === 2 ? c.x - 62 : c.x + 14) / 328) * 100).toFixed(2)}%`, top: `${((c.y / 300) * 100 - 3).toFixed(2)}%` }
}

/** Faint path from the ball to an aimed cell: bends the same way the shot will. */
export function aimPath(zone: number): string {
  const c = cellCentre(zone)
  const midX = (SPOT.x + c.x) / 2 + (zone % 3 === 0 ? 18 : zone % 3 === 2 ? -18 : 0)
  return `M ${SPOT.x} ${SPOT.y - 12} Q ${midX} ${(SPOT.y + c.y) / 2 - 16} ${c.x} ${c.y}`
}

/** The goal, the keeper and the ball. `lean` is the keeper's pre-dive lean, set only while a keeper's pick is selected. */
export function PenaltyWorld({ lastKick, selected, pickRole, lean }: { lastKick: Kick | null; selected: Zone | null; pickRole: Role; lean: 'l' | 'c' | 'r' | undefined }) {
  return (
      <div className="pen-world">
        <div className="pen-back" />
        <div className="pen-net" />
        <div className="pen-frame" />
        <div className="pen-line" />
        <div className="pen-box" />
        <div className="pen-spot" />
        {lastKick ? (
          <>
            <span className="pen-ripple" style={shotSpot(lastKick.zone)} aria-hidden="true" />
            <span className="pen-ripple pen-ripple-2" style={shotSpot(lastKick.zone)} aria-hidden="true" />
          </>
        ) : null}
        <div className="pen-keeper" data-testid="penalty-keeper">
          <div className="pen-keeper-lean" data-lean={lean}>
            <svg className="pen-keeper-svg" viewBox="0 0 36 62" aria-hidden="true">
              <path d="M12 42 L10 60 M24 42 L26 60" stroke="#15181e" strokeWidth="6" strokeLinecap="round" />
              <path d="M9 22 L2 8 M27 22 L34 8" className="shirt" stroke="#15181e" strokeWidth="0" />
              <path d="M9 22 L3 9 M27 22 L33 9" stroke="#15181e" strokeWidth="6.5" strokeLinecap="round" />
              <path d="M9 22 L3 9 M27 22 L33 9" style={{ stroke: 'var(--keeper-shirt-arm, #ffffff)' }} strokeWidth="3.5" strokeLinecap="round" />
              <rect className="shirt" x="7" y="17" width="22" height="27" rx="7" stroke="#15181e" strokeWidth="2" />
              <circle cx="18" cy="9" r="7" fill="#f3d3b4" stroke="#15181e" strokeWidth="2" />
              <circle cx="3" cy="7" r="4" fill="#ffffff" stroke="#15181e" strokeWidth="2" />
              <circle cx="33" cy="7" r="4" fill="#ffffff" stroke="#15181e" strokeWidth="2" />
            </svg>
          </div>
        </div>
        <div className="pen-ball-shadow" />
        {selected !== null && pickRole === 'shooter' && !lastKick ? (
          <svg className="pen-aim-path" viewBox="0 0 328 300" aria-hidden="true" data-testid="penalty-aim">
            <path d={aimPath(selected)} />
          </svg>
        ) : null}
        {lastKick ? <span className="pen-mark pen-mark-dive" data-dive={lastKick.dive} aria-hidden="true" /> : null}
        {lastKick ? <span className="pen-mark pen-mark-shot" style={shotSpot(lastKick.zone)} aria-hidden="true" /> : null}
        <div className="pen-ball" data-testid="penalty-ball">
          <div className="pen-ball-curl">
            <div className="pen-ball-y">
              <div className="pen-ball-rebound">
                <div className="pen-ball-pull">
                  <div className="pen-ball-z">
                    <svg className="pen-ball-svg" viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="12" r="11" fill="#ffffff" stroke="#15181e" strokeWidth="1.5" />
                      <path d="M12 7.5 L16.3 10.6 L14.6 15.6 L9.4 15.6 L7.7 10.6 Z" fill="#15181e" />
                      <path d="M12 7.5 L12 1.5 M16.3 10.6 L22 8.5 M14.6 15.6 L18 20.5 M9.4 15.6 L6 20.5 M7.7 10.6 L2 8.5" stroke="#15181e" strokeWidth="1.3" />
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
  )
}

/** The nine shot spots, or the five dives, as buttons over the goal. */
export function PenaltyZones({ pickRole, selected, over, revealing, onZone }: { pickRole: Role; selected: Zone | null; over: boolean; revealing: boolean; onZone: (zone: Zone) => void }) {
  return (
      <div className="pen-zones" data-kind={pickRole === 'shooter' ? 'kick' : 'dive'}>
        {pickRole === 'shooter'
          ? ZONES.map((z) => (
              <button
                key={z}
                type="button"
                className="pen-zone"
                data-col={z % 3}
                data-row={Math.floor(z / 3)}
                aria-label={ZONE_LABEL[z]}
                aria-pressed={selected === z}
                disabled={over}
                aria-disabled={revealing && !over ? true : undefined}
                onClick={() => onZone(z)}
                data-testid={`penalty-zone-${z}`}
              />
            ))
          : DIVES.map((d) => (
              <button
                key={d.pick}
                type="button"
                className="pen-zone"
                data-col={d.col}
                data-row={d.row}
                aria-label={DIVE_LABEL[d.pick]}
                aria-pressed={selected === d.pick}
                disabled={over}
                aria-disabled={revealing && !over ? true : undefined}
                onClick={() => onZone(d.pick)}
                data-testid={`penalty-zone-${d.pick}`}
              >
                {selected === d.pick ? DIVE_LABEL[d.pick] : null}
              </button>
            ))}
      </div>
  )
}

/** Name tags at the shot and the dive of the last kick. `keeperIsYou`: the keeper's tag sits at its dive spot (below the dive's own label), else beside the keeper. */
export function PenaltyTags({ lastKick, kickerLabel, keeperLabel, keeperIsYou }: { lastKick: Kick; kickerLabel: string; keeperLabel: string; keeperIsYou: boolean }) {
  return (
    <>
      <span className="pen-tag" style={tagAt(lastKick.zone)} aria-hidden="true">
        {kickerLabel}
      </span>
      <span className="pen-tag" style={keeperIsYou ? DIVE_SPOT[lastKick.dive] : KEEPER_TAG[lastKick.dive]} aria-hidden="true">
        {keeperLabel}
      </span>
    </>
  )
}
