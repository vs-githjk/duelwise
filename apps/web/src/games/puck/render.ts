import { GOAL_W, MALLET_R, PHASE, PUCK_EVENTS, PUCK_R, TABLE_L } from '@duelwise/core/src/games/puck/constants'
import type { PuckState } from '@duelwise/core/src/games/puck/state'
import type { Level } from '@duelwise/core/src/product'
import type { Layout } from './input'

// Canvas 2D table. Everything is drawn in table units (1 wide, 2 long) through one transform, so portrait and
// landscape are the same code. The sim runs at 60 Hz; the draw interpolates the last two ticks. The table, lines
// and goals are painted once into an offscreen layer and blitted each frame; the dynamic part allocates nothing.
// Colours come from the Sunroom tokens (tokens.css), read once, so a token change reaches the table.

export interface Theme {
  canvas: string
  surface: string
  surface2: string
  line: string
  ink: string
  muted: string
  action: string
  actionSoft: string
  peach: string
  peachSoft: string
  peachDeep: string
}

export function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string, d: string): string => cs.getPropertyValue(n).trim() || d
  return {
    canvas: v('--canvas', '#fff3e8'), surface: v('--surface', '#ffffff'), surface2: v('--surface-2', '#fde8d8'), line: v('--line', '#a08468'),
    ink: v('--ink', '#1f1a17'), muted: v('--muted', '#6b5f57'), action: v('--action', '#2166f0'), actionSoft: v('--action-soft', '#dce8ff'),
    peach: v('--peach', '#ff9a66'), peachSoft: v('--peach-soft', '#ffdcc4'), peachDeep: v('--peach-deep', '#a63f0c'),
  }
}

/** The opponent's mallet in its persona's colour: a deep tone for the rim and a soft one for the centre. Each reads on the pale table. */
export const OPPONENT_MALLET: Record<Level, { deep: string; soft: string }> = {
  easy: { deep: '#a8691a', soft: '#f3dca6' },
  medium: { deep: '#2f6a9a', soft: '#cfe2f1' },
  hard: { deep: '#6a4a98', soft: '#e1d6f1' },
  champion: { deep: '#2a2724', soft: '#e2c365' },
}

const TRAIL = 7
const FX = 8
const N = 6

interface Fx {
  kind: number
  x: number
  y: number
  born: number
  seat: number
}

export class PuckRenderer {
  private ctx: CanvasRenderingContext2D
  private layer: HTMLCanvasElement
  private layout: Layout = { landscape: false, x: 0, y: 0, scale: 1, edgeGuard: 0 }
  private dpr = 1
  private w = 0
  private h = 0
  private prev = new Float64Array(N)
  private cur = new Float64Array(N)
  private trail = new Float64Array(TRAIL * 2)
  private trailAt = 0
  private fx: Fx[] = []
  private fxN = 0
  private phase: number = PHASE.READY
  private touching = false
  private oppDeep: string | null = null
  private oppSoft: string | null = null
  /** Milliseconds of the last draw call, for the dev HUD. */
  lastDrawMs = 0

  constructor(private readonly canvas: HTMLCanvasElement, private theme: Theme) {
    this.ctx = canvas.getContext('2d', { alpha: false })!
    this.layer = document.createElement('canvas')
    for (let i = 0; i < FX; i++) this.fx.push({ kind: 0, x: 0, y: 0, born: -1e9, seat: 0 })
  }

  /** Paints the opponent's mallet in the persona's colour for this level. */
  setOpponent(level: Level): void {
    this.oppDeep = OPPONENT_MALLET[level].deep
    this.oppSoft = OPPONENT_MALLET[level].soft
    // The far goal bar is the opponent's colour, and it lives in the still layer.
    if (this.w > 0) this.paintLayer()
  }

  setTheme(t: Theme): void {
    this.theme = t
    this.paintLayer()
  }

  /** Sizes the canvas to the viewport (DPR capped at 2) and repaints the still layer. */
  resize(vw: number, vh: number, layout: Layout, rawDpr: number): void {
    this.dpr = Math.min(2, Math.max(1, rawDpr))
    this.w = vw
    this.h = vh
    this.layout = layout
    const pw = Math.round(vw * this.dpr)
    const ph = Math.round(vh * this.dpr)
    this.canvas.width = pw
    this.canvas.height = ph
    this.layer.width = pw
    this.layer.height = ph
    this.paintLayer()
  }

  setTouching(on: boolean): void {
    this.touching = on
  }

  /** Call after each sim tick: shifts the interpolation pair and feeds the trail and the effects. */
  push(s: PuckState, nowMs: number): void {
    const p = this.prev
    this.prev = this.cur
    this.cur = p
    const c = this.cur
    c[0] = s.px; c[1] = s.py
    c[2] = s.m[0].x; c[3] = s.m[0].y
    c[4] = s.m[1].x; c[5] = s.m[1].y
    this.phase = s.phase
    const i = this.trailAt
    this.trail[i * 2] = s.px
    this.trail[i * 2 + 1] = s.py
    this.trailAt = (i + 1) % TRAIL
    if (s.ev !== 0) {
      for (const k of [PUCK_EVENTS.goal, PUCK_EVENTS.shot, PUCK_EVENTS.save, PUCK_EVENTS.post, PUCK_EVENTS.foul]) {
        if (s.ev & (1 << k)) this.addFx(k, s.px, s.py, s.lastEventSeat, nowMs)
      }
    }
  }

  /** Jump both snapshots to the state (match start, rematch). */
  snap(s: PuckState, nowMs: number): void {
    this.push(s, nowMs)
    this.push(s, nowMs)
    this.trail.fill(0)
    for (let i = 0; i < TRAIL; i++) { this.trail[i * 2] = s.px; this.trail[i * 2 + 1] = s.py }
    for (const f of this.fx) f.born = -1e9
  }

  private addFx(kind: number, x: number, y: number, seat: number, t: number): void {
    const f = this.fx[this.fxN]!
    this.fxN = (this.fxN + 1) % FX
    f.kind = kind; f.x = x; f.y = y; f.seat = seat; f.born = t
  }

  private apply(c: CanvasRenderingContext2D): void {
    const l = this.layout
    const k = this.dpr
    if (l.landscape) c.setTransform(0, l.scale * k, l.scale * k, 0, l.x * k, l.y * k)
    else c.setTransform(l.scale * k, 0, 0, -l.scale * k, l.x * k, (l.y + 2 * l.scale) * k)
  }

  private paintLayer(): void {
    const c = this.layer.getContext('2d')!
    const t = this.theme
    const px = 1 / this.layout.scale
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.fillStyle = t.canvas
    c.fillRect(0, 0, this.layer.width, this.layer.height)
    this.apply(c)
    const r = 0.07
    // Soft drop under the table.
    c.save()
    c.shadowColor = 'rgba(60, 30, 10, 0.18)'
    c.shadowBlur = 28 * this.dpr
    c.shadowOffsetY = 8 * this.dpr
    c.fillStyle = t.surface
    c.beginPath(); c.roundRect(0, 0, 1, TABLE_L, r); c.fill()
    c.restore()
    // The surface, with your half tinted: that is where the mallet can go.
    c.save()
    c.beginPath(); c.roundRect(0, 0, 1, TABLE_L, r); c.clip()
    c.fillStyle = t.surface
    c.fillRect(0, 0, 1, TABLE_L)
    c.globalAlpha = 0.55
    c.fillStyle = t.actionSoft
    c.fillRect(0, 0, 1, 1)
    c.globalAlpha = 0.35
    c.fillStyle = t.peachSoft
    c.fillRect(0, 1, 1, 1)
    c.globalAlpha = 1
    // Goal mouths: a bar across the end line, in each side's colour.
    c.fillStyle = t.action
    c.fillRect((1 - GOAL_W) / 2, 0, GOAL_W, 0.02)
    c.fillStyle = this.oppDeep ?? t.peachDeep
    c.fillRect((1 - GOAL_W) / 2, TABLE_L - 0.02, GOAL_W, 0.02)
    // Centre line, circle and dot, and the creases in front of each goal.
    c.strokeStyle = t.line
    c.lineWidth = 2 * px
    c.globalAlpha = 0.55
    c.beginPath(); c.moveTo(0, 1); c.lineTo(1, 1); c.stroke()
    c.beginPath(); c.arc(0.5, 1, 0.19, 0, Math.PI * 2); c.stroke()
    c.beginPath(); c.arc(0.5, 0, 0.3, 0, Math.PI); c.stroke()
    c.beginPath(); c.arc(0.5, TABLE_L, 0.3, Math.PI, Math.PI * 2); c.stroke()
    c.globalAlpha = 1
    c.fillStyle = t.line
    c.beginPath(); c.arc(0.5, 1, 0.012, 0, Math.PI * 2); c.fill()
    // Glass: two soft diagonal reflections across the whole surface, and a shade where the glass meets the rail. Painted once, so the
    // gradients cost nothing per frame.
    const sheen = c.createLinearGradient(0, 0, 1, 1.15)
    sheen.addColorStop(0, 'rgba(255,255,255,0)')
    sheen.addColorStop(0.16, 'rgba(255,255,255,0.34)')
    sheen.addColorStop(0.27, 'rgba(255,255,255,0)')
    sheen.addColorStop(0.58, 'rgba(255,255,255,0)')
    sheen.addColorStop(0.64, 'rgba(255,255,255,0.18)')
    sheen.addColorStop(0.72, 'rgba(255,255,255,0)')
    c.fillStyle = sheen
    c.fillRect(0, 0, 1, TABLE_L)
    c.strokeStyle = 'rgba(60, 30, 10, 0.12)'
    c.lineWidth = 0.03
    c.beginPath(); c.roundRect(0, 0, 1, TABLE_L, r); c.stroke()
    c.strokeStyle = 'rgba(255,255,255,0.55)'
    c.lineWidth = 3 * px
    c.beginPath(); c.roundRect(0.03, 0.03, 0.94, TABLE_L - 0.06, r - 0.02); c.stroke()
    c.restore()
    // Rail: a raised band round the glass, lit from the top left, with a thin bright edge on the lit side and a dark one under it.
    const rail = 0.026
    const band = c.createLinearGradient(0, 0, 1, TABLE_L)
    band.addColorStop(0, '#7a675a')
    band.addColorStop(0.5, '#3b312b')
    band.addColorStop(1, t.ink)
    c.fillStyle = band
    c.beginPath()
    c.roundRect(-rail, -rail, 1 + 2 * rail, TABLE_L + 2 * rail, r + rail)
    c.roundRect(0, 0, 1, TABLE_L, r)
    c.fill('evenodd')
    c.strokeStyle = 'rgba(255,255,255,0.28)'
    c.lineWidth = 1.5 * px
    c.beginPath(); c.roundRect(-rail + 0.75 * px, -rail + 0.75 * px, 1 + 2 * rail - 1.5 * px, TABLE_L + 2 * rail - 1.5 * px, r + rail); c.stroke()
    c.strokeStyle = 'rgba(0,0,0,0.45)'
    c.lineWidth = 1.5 * px
    c.beginPath(); c.roundRect(0.75 * px, 0.75 * px, 1 - 1.5 * px, TABLE_L - 1.5 * px, r); c.stroke()
  }

  /** Draws one frame. `alpha` is the loop's fraction of the next tick; `nowMs` is the rAF time. */
  draw(alpha: number, nowMs: number, s: PuckState): void {
    const t0 = performance.now()
    const c = this.ctx
    const t = this.theme
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.drawImage(this.layer, 0, 0)
    this.apply(c)
    const px = 1 / this.layout.scale
    const a = this.prev
    const b = this.cur
    const lerp = (i: number): number => a[i]! + (b[i]! - a[i]!) * alpha
    const puckX = lerp(0)
    const puckY = lerp(1)

    // Goal flash.
    for (const f of this.fx) {
      const age = nowMs - f.born
      if (f.kind === PUCK_EVENTS.goal && age < 700) {
        const k = 1 - age / 700
        c.globalAlpha = 0.6 * k * k
        const y0 = f.seat === 0 ? TABLE_L : 0
        const g = c.createLinearGradient(0, y0, 0, f.seat === 0 ? TABLE_L - 0.22 : 0.22)
        g.addColorStop(0, f.seat === 0 ? t.peachDeep : t.action)
        g.addColorStop(1, 'rgba(255, 255, 255, 0)')
        c.fillStyle = g
        c.fillRect((1 - GOAL_W) / 2 - 0.06, f.seat === 0 ? TABLE_L - 0.22 : 0, GOAL_W + 0.12, 0.22)
      }
    }
    c.globalAlpha = 1

    // Trail, oldest first, brighter and thicker toward the puck.
    c.lineCap = 'round'
    for (let k = 0; k < TRAIL - 1; k++) {
      const i0 = (this.trailAt + k) % TRAIL
      const i1 = (this.trailAt + k + 1) % TRAIL
      const x0 = this.trail[i0 * 2]!, y0 = this.trail[i0 * 2 + 1]!
      const x1 = this.trail[i1 * 2]!, y1 = this.trail[i1 * 2 + 1]!
      const d2 = (x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)
      if (d2 < 1e-6 || d2 > 0.09) continue
      const f = (k + 1) / (TRAIL - 1)
      c.globalAlpha = 0.28 * f
      c.strokeStyle = t.ink
      c.lineWidth = PUCK_R * 2 * (0.35 + 0.55 * f)
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke()
    }
    c.globalAlpha = 1

    // Mallets.
    this.mallet(c, lerp(4), lerp(5), this.oppDeep ?? t.peachDeep, this.oppSoft ?? t.peachSoft, false)
    this.mallet(c, lerp(2), lerp(3), t.action, t.actionSoft, this.touching)

    // Puck: soft shadow, ink disc, a lighter ring and a highlight.
    c.fillStyle = 'rgba(31, 26, 23, 0.18)'
    c.beginPath(); c.arc(puckX + 0.006, puckY - 0.008, PUCK_R * 1.05, 0, Math.PI * 2); c.fill()
    c.fillStyle = t.ink
    c.beginPath(); c.arc(puckX, puckY, PUCK_R, 0, Math.PI * 2); c.fill()
    c.strokeStyle = t.muted
    c.lineWidth = 2 * px
    c.beginPath(); c.arc(puckX, puckY, PUCK_R * 0.62, 0, Math.PI * 2); c.stroke()
    if (this.phase === PHASE.READY) {
      const pulse = (nowMs % 700) / 700
      c.globalAlpha = 0.6 * (1 - pulse)
      c.strokeStyle = s.serveSeat === 0 ? t.action : t.peachDeep
      c.lineWidth = 3 * px
      c.beginPath(); c.arc(puckX, puckY, PUCK_R * (1.4 + pulse), 0, Math.PI * 2); c.stroke()
      c.globalAlpha = 1
    }

    // Rings on contacts.
    for (const f of this.fx) {
      const age = nowMs - f.born
      if (f.kind === PUCK_EVENTS.goal || age > 380) continue
      const k = age / 380
      c.globalAlpha = 0.55 * (1 - k)
      c.strokeStyle = f.kind === PUCK_EVENTS.foul ? t.peachDeep : t.ink
      c.lineWidth = 2.5 * px
      c.beginPath(); c.arc(f.x, f.y, PUCK_R * (1.2 + 2.6 * k), 0, Math.PI * 2); c.stroke()
    }
    c.globalAlpha = 1
    this.lastDrawMs = performance.now() - t0
  }

  private mallet(c: CanvasRenderingContext2D, x: number, y: number, body: string, soft: string, held: boolean): void {
    const px = 1 / this.layout.scale
    c.fillStyle = 'rgba(31, 26, 23, 0.2)'
    c.beginPath(); c.arc(x + 0.008, y - 0.012, MALLET_R, 0, Math.PI * 2); c.fill()
    if (held) {
      c.globalAlpha = 0.28
      c.fillStyle = body
      c.beginPath(); c.arc(x, y, MALLET_R * 1.55, 0, Math.PI * 2); c.fill()
      c.globalAlpha = 1
    }
    c.fillStyle = body
    c.beginPath(); c.arc(x, y, MALLET_R, 0, Math.PI * 2); c.fill()
    c.strokeStyle = soft
    c.lineWidth = 3 * px
    c.beginPath(); c.arc(x, y, MALLET_R * 0.68, 0, Math.PI * 2); c.stroke()
    c.fillStyle = soft
    c.beginPath(); c.arc(x, y, MALLET_R * 0.3, 0, Math.PI * 2); c.fill()
  }

  /** Where a table point lands in the canvas, for e2e. */
  get size(): { w: number; h: number; dpr: number } {
    return { w: this.w, h: this.h, dpr: this.dpr }
  }
}
