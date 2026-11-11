import { MALLET_R, NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { encodePuckInput, unitToCell } from '@duelwise/core/src/games/puck/input'
import type { Seat } from '@duelwise/core/src/types'
import { NO_INSETS, clampToZone, directAim, screenDeltaToWorld, type Insets, type Layout } from './input'

// Two people on one phone or tablet (friend play, one device). The table is portrait, seat 0 defends the bottom and seat 1 the top.
// Each half of the screen belongs to one finger: a finger that lands in the bottom half steers seat 0, one that lands in the top half
// steers seat 1, and one that lands within CENTRE_DEAD_PX of the centre line steers nobody. A third finger is ignored. The finger
// stays with its seat for its whole life, so dragging across the line clamps the mallet at the line and never steals the other
// mallet. Every seat's input is in its own view (the sim turns seat 1 itself), and the top player's view is the bottom player's view
// turned 180 degrees about the table centre, so a touch at p for seat 1 is the touch at turnPoint(p) for seat 0.
//
// Direct touch: the mallet sits OFFSET px ahead of the finger (toward the other end), so the thumb never covers it. The solo page
// drags relatively from a strip below the table; two strips cannot fit, so friend play uses the direct feel.
// Desktop: the mouse steers seat 0 anywhere on screen with no offset; the arrow keys nudge seat 1 (nudgeScreen).

/** A finger this close to the centre line (CSS px, each side) is claimed by nobody. */
export const CENTRE_DEAD_PX = 12

const HUD_TOP = 64
const HUD_BOTTOM = 60
const PAD = 12

/** A portrait table as large as the screen allows, with room for the two players' score rows. Never landscape, never a thumb strip. */
export function fitLocalLayout(vw: number, vh: number, insets: Insets = NO_INSETS): Layout {
  const top = HUD_TOP + insets.top
  const bottom = HUD_BOTTOM + insets.bottom
  const sideL = Math.max(PAD, insets.left)
  const aw = vw - sideL - Math.max(PAD, insets.right)
  const ah = vh - top - bottom
  const scale = Math.max(1, Math.min(aw, ah / 2, 620))
  return { landscape: false, scale, x: sideL + (aw - scale) / 2, y: top + (ah - scale * 2) / 2, edgeGuard: 0 }
}

/** A screen point turned 180 degrees about the centre of the table. */
export function turnPoint(l: Layout, x: number, y: number): [number, number] {
  return [2 * (l.x + l.scale / 2) - x, 2 * (l.y + l.scale) - y]
}

/** How far ahead of a finger the mallet sits, CSS px: clear of the thumb. */
export function fingerOffset(l: Layout): number {
  return Math.round(MALLET_R * l.scale + 18)
}

interface Hand {
  pid: number
  /** The held target in the seat's own view. */
  x: number
  y: number
  dirty: boolean
}

export class TwoHands {
  private readonly hands: [Hand, Hand] = [
    { pid: -1, x: 0.5, y: 0.3, dirty: false },
    { pid: -1, x: 0.5, y: 0.3, dirty: false },
  ]
  /** The one pointer that is a mouse, if any. */
  private mouse = -1

  constructor(private layout: Layout, private readonly offsetPx: number = fingerOffset(layout)) {}

  setLayout(l: Layout): void {
    this.layout = l
  }

  /** Put a seat's held target on its mallet (match start, rematch). */
  reset(seat: Seat, x: number, y: number): void {
    const h = this.hands[seat]
    h.x = x
    h.y = y
    h.dirty = false
    h.pid = -1
    if (seat === 0) this.mouse = -1
  }

  target(seat: Seat): [number, number] {
    const h = this.hands[seat]
    return [h.x, h.y]
  }

  /** Which seat a finger at screen height `y` would claim, or null in the dead band at the centre line. */
  seatAt(y: number): Seat | null {
    const c = this.layout.y + this.layout.scale
    if (Math.abs(y - c) < CENTRE_DEAD_PX) return null
    return y > c ? 0 : 1
  }

  /** The seat this pointer now steers, or null when it steers nothing (dead band, half already held, third finger). */
  down(id: number, type: string, x: number, y: number): Seat | null {
    if (this.seatOf(id) !== null) return null
    if (type === 'mouse') {
      if (this.hands[0].pid !== -1) return null
      this.hands[0].pid = id
      this.mouse = id
      this.aim(0, x, y, 0)
      return 0
    }
    const seat = this.seatAt(y)
    if (seat === null || this.hands[seat].pid !== -1) return null
    this.hands[seat].pid = id
    this.aim(seat, x, y, this.offsetPx)
    return seat
  }

  /** The seat this pointer steers, or null when it is not one of ours. */
  move(id: number, x: number, y: number): Seat | null {
    const seat = this.seatOf(id)
    if (seat === null) return null
    this.aim(seat, x, y, id === this.mouse ? 0 : this.offsetPx)
    return seat
  }

  up(id: number): Seat | null {
    const seat = this.seatOf(id)
    if (seat === null) return null
    this.hands[seat].pid = -1
    if (id === this.mouse) this.mouse = -1
    return seat
  }

  /** A pointer that was cancelled, or the window lost focus: every finger is lifted. */
  cancelAll(): void {
    this.hands[0].pid = -1
    this.hands[1].pid = -1
    this.mouse = -1
  }

  /** A held key moves a seat's target by a screen distance (px); the top seat's own view is turned, so it moves the other way. */
  nudgeScreen(seat: Seat, dxPx: number, dyPx: number): void {
    const s = seat === 0 ? 1 : -1
    const [dx, dy] = screenDeltaToWorld(this.layout, dxPx * s, dyPx * s)
    this.set(seat, this.hands[seat].x + dx, this.hands[seat].y + dy)
  }

  /** This seat's cell code for the tick: the new target if it changed since the last call, else NO_INPUT (the sim holds it). */
  takeCode(seat: Seat): number {
    const h = this.hands[seat]
    if (!h.dirty) return NO_INPUT
    h.dirty = false
    return encodePuckInput({ tx: unitToCell(h.x), ty: unitToCell(h.y) })
  }

  private seatOf(id: number): Seat | null {
    return this.hands[0].pid === id ? 0 : this.hands[1].pid === id ? 1 : null
  }

  private aim(seat: Seat, sx: number, sy: number, offsetPx: number): void {
    const [px, py] = seat === 0 ? [sx, sy] : turnPoint(this.layout, sx, sy)
    const [wx, wy] = directAim(this.layout, px, py, offsetPx)
    this.set(seat, wx, wy)
  }

  private set(seat: Seat, x: number, y: number): void {
    const h = this.hands[seat]
    const [cx, cy] = clampToZone(x, y)
    if (cx !== h.x || cy !== h.y) {
      h.x = cx
      h.y = cy
      h.dirty = true
    }
  }
}
