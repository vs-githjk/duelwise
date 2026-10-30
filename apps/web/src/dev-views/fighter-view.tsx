import { useEffect, useRef, useState } from 'react'
import { MOVES } from '@duelwise/core/src/games/fighter/moves.ts'
import { unmappedMoves } from '../games/fighter/render/animation-map'
import { buildFixture, FIXTURE_FRAMES } from '../games/fighter/render/fixture'
import { FighterRenderer, type HudSnapshot } from '../games/fighter/render/FighterRenderer'

// Dev-only view of the fighter renderer: plays a 20 second fixture replay (two scripted bots) and
// exposes window.__fighterView for the render spec (frame counter, pixel sample, frame times).
// ?quality=low turns off bloom and shadows; ?capture=1 keeps the drawing buffer readable.

interface FrameStats {
  count: number
  p50: number
  p95: number
  max: number
  renderP50: number
  renderP95: number
  renderer: string
}

const pct = (a: number[], p: number): number => {
  if (a.length === 0) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!
}

export default function FighterView() {
  const host = useRef<HTMLDivElement>(null)
  const [hud, setHud] = useState<HudSnapshot | null>(null)
  const [status, setStatus] = useState('loading')

  useEffect(() => {
    const el = host.current
    if (!el) return
    const q = new URLSearchParams(window.location.search)
    const states = buildFixture()
    const intervals: number[] = []
    const renders: number[] = []
    const glErrors: string[] = []
    const api = {
      ready: false,
      done: false,
      frame: 0,
      loadError: null as string | null,
      unmappedMoves: unmappedMoves(),
      moveCount: MOVES.filter(Boolean).length,
      glErrors,
      sample: () => ({ width: 0, height: 0, litFraction: 0, distinct: 0 }),
      frameStats: (): FrameStats => ({ count: 0, p50: 0, p95: 0, max: 0, renderP50: 0, renderP95: 0, renderer: '' }),
    }
    window.__fighterView = api as never
    let raf = 0
    let stopped = false
    let hudAt = 0
    const r = new FighterRenderer({
      quality: q.get('quality') === 'low' ? 'low' : 'high',
      preserveDrawingBuffer: q.get('capture') === '1',
      onHud: (h) => {
        if (h.frame - hudAt >= 6 || h.hits.length > 0) {
          hudAt = h.frame
          setHud(h)
        }
      },
    })

    api.sample = () => {
      const src = r.canvas!
      const c = document.createElement('canvas')
      c.width = 160
      c.height = 90
      const g = c.getContext('2d', { willReadFrequently: true })!
      g.drawImage(src, 0, 0, 160, 90)
      const px = g.getImageData(0, 0, 160, 90).data
      let lit = 0
      const seen = new Set<number>()
      for (let i = 0; i < px.length; i += 4) {
        const l = 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!
        if (l > 14) lit++
        seen.add(((px[i]! >> 3) << 10) | ((px[i + 1]! >> 3) << 5) | (px[i + 2]! >> 3))
      }
      return { width: src.width, height: src.height, litFraction: lit / (px.length / 4), distinct: seen.size }
    }
    api.frameStats = () => ({
      count: intervals.length,
      p50: pct(intervals, 0.5),
      p95: pct(intervals, 0.95),
      max: Math.max(0, ...intervals),
      renderP50: pct(renders, 0.5),
      renderP95: pct(renders, 0.95),
      renderer: r.info.renderer,
    })

    const ro = new ResizeObserver(() => r.resize(Math.max(1, el.clientWidth), Math.max(1, el.clientHeight)))
    ro.observe(el)

    r.mount(el)
      .then(() => {
        if (stopped) return
        const gl = r.canvas!.getContext('webgl2') ?? r.canvas!.getContext('webgl')
        r.canvas!.addEventListener('webglcontextlost', () => glErrors.push('context lost'))
        api.ready = true
        setStatus('playing')
        let idx = 1
        let acc = 0
        let last = performance.now()
        const tick = (now: number) => {
          if (stopped) return
          const dt = Math.min(0.1, (now - last) / 1000)
          intervals.push(now - last)
          last = now
          acc += dt * 60
          while (acc >= 1 && idx < FIXTURE_FRAMES) {
            acc -= 1
            idx++
            // Every sim step derives its own effects, even when one render spans several steps.
            r.onStep(states[idx - 1]!, states[idx]!)
          }
          if (idx >= FIXTURE_FRAMES) {
            acc = 0
            if (!api.done) {
              api.done = true
              setStatus('done')
            }
          }
          api.frame = idx
          r.render(states[idx - 1]!, states[idx]!, acc, [])
          renders.push(r.lastRenderMs)
          if (gl && idx % 30 === 0) {
            const e = gl.getError()
            if (e !== 0) glErrors.push(`gl error ${e} at frame ${idx}`)
          }
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
      })
      .catch((e: unknown) => {
        api.loadError = e instanceof Error ? e.message : String(e)
        setStatus('error')
      })

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      r.dispose()
      delete window.__fighterView
    }
  }, [])

  return (
    <div className="grid gap-3 py-4">
      <div ref={host} className="aspect-video w-full overflow-hidden rounded-lg bg-black" data-testid="fighter-stage" />
      <p className="font-mono text-xs text-muted" data-testid="fighter-status">
        {status}
        {hud ? ` | frame ${hud.frame} | round ${hud.round} | hp ${hud.health[0]} / ${hud.health[1]} | surge ${hud.surge[0]} / ${hud.surge[1]} | combo ${hud.combo[0]} / ${hud.combo[1]}` : ''}
      </p>
    </div>
  )
}
