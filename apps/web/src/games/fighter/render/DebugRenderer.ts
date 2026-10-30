import { STAGE_HALF } from '@duelwise/core/src/games/fighter/constants'
import { hitBoxWorld, isActiveFrame, isCrouching } from '@duelwise/core/src/games/fighter/collision'
import { isAttackId } from '@duelwise/core/src/games/fighter/moves'
import type { FighterState } from '@duelwise/core/src/games/fighter/state'

// The "debug view": a plain 2D canvas of boxes. The play page uses it when the 3D stage cannot start
// (no WebGL, or the visual task T33 is not in the build), so the agent and input path never depend on the
// renderer. It reads sim state only. The page labels it "debug view" next to the stage.

export interface StageRenderer {
  readonly label: 'stage' | 'debug view'
  mount(el: HTMLElement): Promise<void>
  /** Called once per sim step so effects of skipped frames are not lost (the 3D renderer uses it). */
  onStep(prev: FighterState, next: FighterState): void
  render(prev: FighterState, next: FighterState, alpha: number, events: unknown[]): void
  resize(w: number, h: number): void
  dispose(): void
}

const BODY_W = 90
const STAND_H = 170
const CROUCH_H = 110
const SEAT_COLOR = ['#f2c94c', '#7cc4ff']

export class DebugRenderer implements StageRenderer {
  readonly label = 'debug view'
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private w = 1
  private h = 1
  private dpr = 1

  async mount(el: HTMLElement): Promise<void> {
    const c = document.createElement('canvas')
    c.className = 'block size-full'
    c.setAttribute('aria-label', 'Fighter stage, debug view')
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

  onStep(): void {}

  render(prev: FighterState, next: FighterState, alpha: number): void {
    const g = this.ctx
    if (!g) return
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.fillStyle = '#0b0d14'
    g.fillRect(0, 0, this.w, this.h)
    // World x in [-STAGE_HALF, STAGE_HALF] across the width with a margin; the floor sits near the bottom.
    const scale = (this.w * 0.86) / (2 * STAGE_HALF)
    const floor = this.h * 0.82
    const sx = (x: number) => this.w / 2 + x * scale
    const sy = (y: number) => floor - y * scale
    g.fillStyle = '#1b2030'
    g.fillRect(0, floor, this.w, this.h - floor)
    g.strokeStyle = 'rgba(255,255,255,0.25)'
    g.beginPath()
    g.moveTo(0, floor)
    g.lineTo(this.w, floor)
    g.stroke()
    const a = Math.min(1, Math.max(0, alpha))
    const advanced = prev.frame === next.frame - 1
    for (let i = 0; i < 2; i++) {
      const f = next.fighters[i]!
      const p = prev.fighters[i]!
      const x = advanced ? p.pos.x + (f.pos.x - p.pos.x) * a : f.pos.x
      const y = advanced ? p.pos.y + (f.pos.y - p.pos.y) * a : f.pos.y
      const hgt = (isCrouching(f) ? CROUCH_H : STAND_H) * scale
      g.fillStyle = SEAT_COLOR[i]!
      g.globalAlpha = f.hitstop > 0 ? 0.6 : 0.9
      g.fillRect(sx(x) - (BODY_W * scale) / 2, sy(y) - hgt, BODY_W * scale, hgt)
      g.globalAlpha = 1
      // Facing tick.
      g.fillStyle = '#fff'
      g.fillRect(sx(x) + f.facing * ((BODY_W * scale) / 2) - 2, sy(y) - hgt + 12 * scale, 4, 10 * scale)
      if (isAttackId(f.moveId) && isActiveFrame(f)) {
        const box = new Int32Array(4)
        hitBoxWorld(f, box)
        g.strokeStyle = '#ff4d6d'
        g.lineWidth = 2
        g.strokeRect(sx(box[0]!), sy(box[3]!), (box[2]! - box[0]!) * scale, (box[3]! - box[1]!) * scale)
      }
      const pr = f.projectile
      if (pr.on !== 0) {
        g.fillStyle = '#ffc070'
        g.beginPath()
        g.arc(sx(pr.x), sy(pr.y + 100), 14 * scale + 4, 0, Math.PI * 2)
        g.fill()
      }
    }
  }

  dispose(): void {
    this.canvas?.remove()
    this.canvas = null
    this.ctx = null
  }
}
