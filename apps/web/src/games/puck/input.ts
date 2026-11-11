import { MALLET_R, NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { encodePuckInput, unitToCell } from '@duelwise/core/src/games/puck/input'
import { zoneYHi, zoneYLo } from '@duelwise/core/src/games/puck/physics'

// Air hockey input for the web: where the table sits on screen, and how a finger or a cursor becomes the
// mallet target. The page asks takeCode() once per sim tick, so a move is applied on the very next tick.
//
// Phone (touch or pen): a RELATIVE drag. Touching down anywhere moves nothing; the mallet then follows the
// finger's movement 1:1 in table units. The finger can rest in the thumb strip below (portrait) or beside
// (landscape) the table, so the thumb is behind the mallet and never over the puck. Only the first finger
// counts, and a clamp at the line or a wall keeps no wind-up: pushing past the limit and coming back moves
// the mallet at once.
// Desktop (mouse): ABSOLUTE inside your half. The mallet goes where the cursor is, clamped at the centre line.
// ?direct=1 on the dev page switches touch to a direct mode (mallet a thumb-width above the finger) so the
// two can be compared in one test (plan risk 3).

export interface Layout {
  /** Landscape puts your goal on the left and the opponent's on the right; portrait puts yours at the bottom. */
  landscape: boolean
  /** Top-left corner of the table, CSS px. */
  x: number
  y: number
  /** CSS px per table unit (the table is 1 wide and 2 long). */
  scale: number
  /** Landscape touch only: a finger that lands closer than this to the left screen edge is not claimed (Safari's swipe back lives there). 0 elsewhere. */
  edgeGuard: number
}

/** Space the OS keeps for a notch, the Dynamic Island, rounded corners and the home indicator, CSS px. */
export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 }

/** Reads env(safe-area-inset-*) into px with a throwaway probe element (CSS env() is not readable from JS directly). Zeros off the DOM. */
export function readSafeInsets(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): Insets {
  if (!doc?.body) return NO_INSETS
  const probe = doc.createElement('div')
  probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)'
  doc.body.appendChild(probe)
  const cs = doc.defaultView?.getComputedStyle(probe)
  const px = (v: string | undefined): number => Math.max(0, Number.parseFloat(v ?? '') || 0)
  const out = { top: px(cs?.paddingTop), right: px(cs?.paddingRight), bottom: px(cs?.paddingBottom), left: px(cs?.paddingLeft) }
  probe.remove()
  return out
}

/** Height of the score HUD (puck.css), which sits at max(8px, safe-area-inset-top). */
export const HUD_H = 46
/** Landscape touch: a finger must land at least this far (plus the left inset) from the screen edge to steer. */
export const EDGE_GUARD = 24
const HUD_GAP = 10
const PORTRAIT_HUD_TOP = 72
const PORTRAIT_STRIP = 124
const LANDSCAPE_STRIP = 100
const LANDSCAPE_HUD_TOP = 60
/** A desktop table stops growing here (px per table width), so a mouse does not sweep a whole monitor. */
const MAX_SCALE = 620

/** The table as large as it fits, centred in what the HUD and the thumb strip leave. `touch` reserves the strip. */
export function fitLayout(vw: number, vh: number, touch: boolean, insets: Insets = NO_INSETS): Layout {
  const landscape = vw > vh
  const pad = 12
  const hudBottom = Math.max(8, insets.top) + HUD_H + HUD_GAP
  if (!landscape) {
    const top = Math.max(PORTRAIT_HUD_TOP, hudBottom)
    const bottom = (touch ? PORTRAIT_STRIP : pad) + insets.bottom
    const sideL = Math.max(pad, insets.left)
    const aw = vw - sideL - Math.max(pad, insets.right)
    const ah = vh - top - bottom
    const scale = Math.max(1, Math.min(aw, ah / 2, MAX_SCALE))
    return { landscape, scale, x: sideL + (aw - scale) / 2, y: top + (ah - scale * 2) / 2, edgeGuard: 0 }
  }
  const left = (touch ? LANDSCAPE_STRIP : pad) + insets.left
  const top = Math.max(LANDSCAPE_HUD_TOP, hudBottom)
  const aw = vw - left - Math.max(pad, insets.right)
  const ah = vh - top - Math.max(pad, insets.bottom)
  const scale = Math.max(1, Math.min(aw / 2, ah, MAX_SCALE))
  return { landscape, scale, x: left + (aw - scale * 2) / 2, y: top + (ah - scale) / 2, edgeGuard: touch ? insets.left + EDGE_GUARD : 0 }
}

export function worldToScreen(l: Layout, wx: number, wy: number): [number, number] {
  return l.landscape ? [l.x + wy * l.scale, l.y + wx * l.scale] : [l.x + wx * l.scale, l.y + (2 - wy) * l.scale]
}

export function screenToWorld(l: Layout, sx: number, sy: number): [number, number] {
  return l.landscape ? [(sy - l.y) / l.scale, (sx - l.x) / l.scale] : [(sx - l.x) / l.scale, 2 - (sy - l.y) / l.scale]
}

/** A screen movement in px as a table movement. */
export function screenDeltaToWorld(l: Layout, dx: number, dy: number): [number, number] {
  return l.landscape ? [dy / l.scale, dx / l.scale] : [dx / l.scale, -dy / l.scale]
}

/** Where a finger or cursor at screen point (sx, sy) aims the mallet, in table units. `offsetPx` puts the mallet that far ahead of the finger (toward the opponent). */
export function directAim(l: Layout, sx: number, sy: number, offsetPx: number): [number, number] {
  let px = sx
  let py = sy
  if (l.landscape) px += offsetPx
  else py -= offsetPx
  return screenToWorld(l, px, py)
}

/** A table point clamped to seat 0's mallet zone (the walls and the centre line), in the seat's own view. */
export function clampToZone(x: number, y: number): [number, number] {
  const cx = x < MALLET_R ? MALLET_R : x > 1 - MALLET_R ? 1 - MALLET_R : x
  const lo = zoneYLo(0)
  const hi = zoneYHi(0)
  return [cx, y < lo ? lo : y > hi ? hi : y]
}

export interface ControlOptions {
  /** Touch maps the finger straight to the table with the mallet `offsetPx` ahead of it (dev compare). */
  direct?: boolean
  offsetPx?: number
  /** Relative drag gain; 1 is 1:1. */
  gain?: number
}

export class MalletControl {
  private tx = 0.5
  private ty = 0.3
  private dirty = false
  private pid = -1
  private lastX = 0
  private lastY = 0
  private lastT = 0
  private anchored = false
  /** Fastest finger movement seen, table widths a second (dev HUD). */
  peakSpeed = 0

  constructor(private layout: Layout, private readonly opts: ControlOptions = {}) {}

  setLayout(l: Layout): void {
    // After a rotation the next finger position is in a new frame, so it is the new anchor, not a delta.
    if (l.landscape !== this.layout.landscape) this.anchored = false
    this.layout = l
  }

  /** Put the held target on the mallet (match start, rematch). */
  reset(x: number, y: number): void {
    this.tx = x
    this.ty = y
    this.dirty = false
    this.pid = -1
    this.anchored = false
  }

  target(): [number, number] {
    return [this.tx, this.ty]
  }

  /** True when this pointer is the one steering. */
  active(id: number): boolean {
    return id === this.pid
  }

  down(id: number, type: string, x: number, y: number, t: number): boolean {
    if (type === 'mouse') return this.move(id, type, x, y, t)
    if (this.pid !== -1 && this.pid !== id) return false
    if (x < this.layout.edgeGuard) return false
    this.pid = id
    this.lastX = x
    this.lastY = y
    this.lastT = t
    this.anchored = true
    if (this.opts.direct) this.aim(x, y)
    return true
  }

  move(id: number, type: string, x: number, y: number, t: number): boolean {
    if (type === 'mouse') {
      this.aim(x, y)
      return true
    }
    if (id !== this.pid) return false
    if (this.opts.direct) {
      this.aim(x, y)
      return true
    }
    if (!this.anchored) {
      this.lastX = x
      this.lastY = y
      this.lastT = t
      this.anchored = true
      return true
    }
    const g = this.opts.gain ?? 1
    const [dx, dy] = screenDeltaToWorld(this.layout, x - this.lastX, y - this.lastY)
    const dt = t - this.lastT
    if (dt > 0) {
      const v = Math.hypot(dx, dy) / (dt / 1000)
      if (v > this.peakSpeed) this.peakSpeed = v
    }
    this.lastX = x
    this.lastY = y
    this.lastT = t
    this.set(this.tx + dx * g, this.ty + dy * g)
    return true
  }

  up(id: number): void {
    if (id === this.pid) {
      this.pid = -1
      this.anchored = false
    }
  }

  /** A pointer that was cancelled or left the window: same as lifting. */
  cancelAll(): void {
    this.pid = -1
    this.anchored = false
  }

  /** The cell code for this tick: the new target if it changed since the last call, else NO_INPUT (the sim holds it). */
  takeCode(): number {
    if (!this.dirty) return NO_INPUT
    this.dirty = false
    return encodePuckInput({ tx: unitToCell(this.tx), ty: unitToCell(this.ty) })
  }

  private aim(sx: number, sy: number): void {
    const [wx, wy] = directAim(this.layout, sx, sy, this.opts.direct ? (this.opts.offsetPx ?? 0) : 0)
    this.set(wx, wy)
  }

  private set(x: number, y: number): void {
    const [cx, cy] = clampToZone(x, y)
    if (cx !== this.tx || cy !== this.ty) {
      this.tx = cx
      this.ty = cy
      this.dirty = true
    }
  }
}
