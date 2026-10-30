import { MAP_LIST } from '@duelwise/core/src/games/arena/map'
import { EV, type ArenaState } from '@duelwise/core/src/games/arena/state'
import { cosU, sinU } from '@duelwise/core/src/games/arena/trig'

// The "debug view": a plain top-down 2D canvas. The play page uses it when the 3D scene cannot start
// (no WebGL, a failed asset load), so the agent and input path never depend on the renderer. It reads
// sim state only and shows what the human seat could see: the opponent is drawn only while the sim's own
// line of sight check says this seat sees it, never from the true position. The page labels it "debug view".

export interface StageRenderer {
  readonly label: 'stage' | 'debug view'
  mount(el: HTMLElement): Promise<void>
  /** Called once per sim step so effects of skipped frames are not lost (the 3D renderer uses it). */
  onStep(prev: ArenaState, next: ArenaState): void
  render(prev: ArenaState, next: ArenaState, alpha: number): void
  resize(w: number, h: number): void
  /** The mouse turn the sim has not taken yet (angle units), so the view can follow the mouse every rendered frame. */
  setPendingTurn?(t: { yaw: number; pitch: number } | null): void
  /** Starts sound; call from a click or key press. */
  unlockAudio?(): void
  dispose(): void
}

/** True when `seat` sees its opponent in the current sim frame: the only moment the opponent may be drawn for that seat. */
export function opponentVisible(s: ArenaState, seat: 0 | 1): boolean {
  const me = s.players[seat]
  return me.alive === 1 && me.lsKnown === 1 && me.lsAge === 0
}

const BODY_R = 16
const TRACER_FRAMES = 8
const SEAT_COLOR = ['#f2c94c', '#7cc4ff']

export class DebugRenderer implements StageRenderer {
  readonly label = 'debug view'
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private w = 1
  private h = 1
  private dpr = 1
  private shots: Array<{ x0: number; y0: number; x1: number; y1: number; left: number; mine: boolean }> = []
  /** Whether the last render() drew the opponent (tests compare it with opponentVisible). */
  opponentDrawn = false

  async mount(el: HTMLElement): Promise<void> {
    const c = document.createElement('canvas')
    c.className = 'block size-full'
    c.setAttribute('aria-label', 'Coldstore, top-down debug view')
    el.appendChild(c)
    this.canvas = c
    this.ctx = c.getContext('2d')
    this.resize(Math.max(1, el.clientWidth), Math.max(1, el.clientHeight))
  }

  resize(w: number, h: number): void {
    this.w = w
    this.h = h
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (!this.canvas) return
    this.canvas.width = Math.round(w * this.dpr)
    this.canvas.height = Math.round(h * this.dpr)
  }

  onStep(_prev: ArenaState, next: ArenaState): void {
    for (const i of [0, 1] as const) {
      const p = next.players[i]!
      if (!(p.events & EV.FIRED)) continue
      // Only your own tracer, and the opponent's while you can see it: no shot reveals where an unseen opponent stands.
      if (i === 1 && !opponentVisible(next, 0)) continue
      const yaw = p.yaw + p.punchYaw
      this.shots.push({ x0: p.x, y0: p.y, x1: p.x + cosU(yaw) * 900, y1: p.y + sinU(yaw) * 900, left: TRACER_FRAMES, mine: i === 0 })
    }
  }

  render(prev: ArenaState, next: ArenaState, alpha: number): void {
    const ctx = this.ctx
    if (!ctx) return
    const map = MAP_LIST[next.mapIdx] ?? MAP_LIST[0]!
    const b = map.bounds
    const pad = 24
    const scale = Math.min((this.w - pad * 2) / (b.x1 - b.x0), (this.h - pad * 2) / (b.y1 - b.y0))
    const ox = (this.w - (b.x1 - b.x0) * scale) / 2
    const oy = (this.h - (b.y1 - b.y0) * scale) / 2
    const sx = (x: number) => ox + (x - b.x0) * scale
    const sy = (y: number) => oy + (b.y1 - y) * scale // +y is up the screen
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.fillStyle = '#0b0e13'
    ctx.fillRect(0, 0, this.w, this.h)
    ctx.fillStyle = '#141a22'
    ctx.fillRect(sx(b.x0), sy(b.y1), (b.x1 - b.x0) * scale, (b.y1 - b.y0) * scale)
    ctx.fillStyle = '#3a4350'
    for (const box of map.json.boxes) ctx.fillRect(sx(box.x0), sy(box.y1), (box.x1 - box.x0) * scale, (box.y1 - box.y0) * scale)

    const a = Math.min(1, Math.max(0, alpha))
    const lerp = (p: number, n: number) => p + (n - p) * (prev.frame === next.frame - 1 ? a : 1)
    const drawPlayer = (i: 0 | 1) => {
      const p = next.players[i]!
      const q = prev.players[i]!
      const x = sx(lerp(q.x, p.x))
      const y = sy(lerp(q.y, p.y))
      ctx.globalAlpha = p.alive === 1 ? 1 : 0.35
      ctx.fillStyle = SEAT_COLOR[i]!
      ctx.beginPath()
      ctx.arc(x, y, BODY_R * scale + 2, 0, Math.PI * 2)
      ctx.fill()
      const yaw = (p.yaw / 8192) * Math.PI * 2
      ctx.strokeStyle = SEAT_COLOR[i]!
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + Math.cos(yaw) * 26, y - Math.sin(yaw) * 26)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    drawPlayer(0)
    this.opponentDrawn = opponentVisible(next, 0)
    if (this.opponentDrawn) drawPlayer(1)

    this.shots = this.shots.filter((s) => s.left > 0)
    for (const s of this.shots) {
      ctx.strokeStyle = s.mine ? '#fff3c4' : '#ff8a70'
      ctx.globalAlpha = s.left / TRACER_FRAMES
      ctx.beginPath()
      ctx.moveTo(sx(s.x0), sy(s.y0))
      ctx.lineTo(sx(s.x1), sy(s.y1))
      ctx.stroke()
      ctx.globalAlpha = 1
      s.left -= 1
    }
  }

  dispose(): void {
    this.canvas?.remove()
    this.canvas = null
    this.ctx = null
  }
}
