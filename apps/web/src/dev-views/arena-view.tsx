import { useEffect, useRef, useState } from 'react'
import type { BotKind } from '@duelwise/core/src/games/arena/bots.ts'
import { createState } from '@duelwise/core/src/games/arena/core.ts'
import { cloneState, type ArenaState } from '@duelwise/core/src/games/arena/state.ts'
import { MAP_LIST } from '@duelwise/core/src/games/arena/map.ts'
import { ArenaRenderer, type ViewSnapshot } from '../games/arena/render/ArenaRenderer'
import { buildFixture, FIXTURE_FRAMES } from '../games/arena/render/fixture'
import { simBoundsOfMesh } from '../games/arena/render/map-mesh'

// Dev-only view of the arena renderer: plays a 25 second fixture replay (two scripted bots, you are
// seat 0) and exposes window.__arenaView for the render spec (frame counter, pixel sample, frame
// times, the map-versus-sim box check). ?quality=low turns shadows off, ?capture=1 keeps the drawing
// buffer readable, ?hold=<frame> draws that one frame forever (for stills), ?seed=N and ?kinds=rusher,holder pick another fixture, ?guns=1,2 gives each seat a weapon from the start, ?seat=1 follows the other seat.

interface FrameStats {
  count: number
  p50: number
  p95: number
  max: number
  renderP50: number
  renderP95: number
  renderer: string
}

/** ?pose=idle|run|crouch|dead|hit (&weapon=N for the opponent's gun, &own=N for yours, &at=x,y,yaw to move you): a still scene with the opponent 3.5 m ahead facing you, for looking at the character. */
function closeUp(pose: string, weapon = 1, own = 2, at?: number[]): ArenaState[] {
  const s = createState(1, { buyFrames: 0, roundFrames: 3000 })
  const a = s.players[0]
  const b = s.players[1]
  a.x = -150; a.y = 20; a.yaw = 0; a.weapon = own
  b.x = -60; b.y = 20; b.yaw = 4096; b.weapon = weapon
  if (at && at.length === 3) [a.x, a.y, a.yaw] = at as [number, number, number]
  if (pose === 'run') b.vx = -215
  if (pose === 'crouch') b.crouch = 1
  if (pose === 'dead') b.alive = 0
  return [cloneState(s), cloneState(s), cloneState(s)]
}

const pct = (a: number[], p: number): number => {
  if (a.length === 0) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!
}

export default function ArenaView() {
  const host = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<ViewSnapshot | null>(null)
  const [status, setStatus] = useState('loading')

  useEffect(() => {
    const el = host.current
    if (!el) return
    const q = new URLSearchParams(window.location.search)
    const hold = q.get('hold') ? Number(q.get('hold')) : null
    const kinds = (q.get('kinds') ?? '').split(',')
    const guns = (q.get('guns') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 3)
    const states = q.get('pose') ? closeUp(q.get('pose')!, q.get('weapon') ? Number(q.get('weapon')) : 1, q.get('own') ? Number(q.get('own')) : 2, q.get('at')?.split(',').map(Number)) : buildFixture(q.get('seed') ? Number(q.get('seed')) : undefined, FIXTURE_FRAMES, kinds.length === 2 ? [kinds[0] as BotKind, kinds[1] as BotKind] : undefined, guns.length === 2 ? [guns[0]!, guns[1]!] : undefined)
    const intervals: number[] = []
    const renders: number[] = []
    const glErrors: string[] = []
    const map = MAP_LIST[0]!
    const api = {
      ready: false,
      done: false,
      frame: 0,
      loadError: null as string | null,
      expectedBoxes: map.boxCount,
      glErrors,
      shots: 0,
      hits: 0,
      boxCheck: () => ({ meshes: 0, mismatches: 0 }),
      sample: () => ({ width: 0, height: 0, litFraction: 0, distinct: 0 }),
      frameStats: (): FrameStats => ({ count: 0, p50: 0, p95: 0, max: 0, renderP50: 0, renderP95: 0, renderer: '' }),
      decals: () => 0,
      barrelStats: () => ({ count: 0, max: 0, mean: 0, pistolFrames: 0 }),
      torsoCoverage: (): { rect: [number, number, number, number]; torsoPixels: number; coveredPixels: number } | null => null,
    }
    window.__arenaView = api as never
    let raf = 0
    let stopped = false
    let viewAt = 0
    const r = new ArenaRenderer({
      quality: q.get('quality') === 'low' ? 'low' : 'high',
      seat: q.get('seat') === '1' ? 1 : 0,
      preserveDrawingBuffer: q.get('capture') === '1',
      audio: false,
      onView: (v) => {
        if (v.fired) api.shots++
        if (v.hit) api.hits++
        if (v.frame - viewAt >= 6 || v.hit) {
          viewAt = v.frame
          setView(v)
        }
      },
    })

    api.boxCheck = () => {
      let mismatches = 0
      const meshes = r.boxMeshes
      const built = r.mapData ?? map
      for (let i = 0; i < built.boxCount; i++) {
        const m = meshes[i]
        if (!m || m.userData.boxIndex !== i) {
          mismatches++
          continue
        }
        const b = simBoundsOfMesh(m)
        const want = [built.boxes[i * 6]!, built.boxes[i * 6 + 1]!, built.boxes[i * 6 + 2]!, built.boxes[i * 6 + 3]!, built.boxes[i * 6 + 4]!, built.boxes[i * 6 + 5]!]
        const got = [...b.min, ...b.max]
        if (got.some((g, k) => Math.abs(g - want[k]!) > 1e-6)) mismatches++
      }
      return { meshes: meshes.length, mismatches }
    }
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
    api.decals = () => r.info.decals
    api.torsoCoverage = () => r.viewmodelTorsoCoverage()
    // Barrel to eye alignment over the replay: the miss distance whenever the opponent holds a rifle and aims fully at your eye.
    const misses: number[] = []
    let pistolFrames = 0
    api.barrelStats = () => ({ count: misses.length, max: Math.max(0, ...misses), mean: misses.length ? misses.reduce((x, y) => x + y, 0) / misses.length : 0, pistolFrames })

    const ro = new ResizeObserver(() => r.resize(Math.max(1, el.clientWidth), Math.max(1, el.clientHeight)))
    ro.observe(el)

    r.mount(el)
      .then(() => {
        if (stopped) return
        const gl = r.canvas!.getContext('webgl2') ?? r.canvas!.getContext('webgl')
        r.canvas!.addEventListener('webglcontextlost', () => glErrors.push('context lost'))
        api.ready = true
        setStatus('playing')
        let idx = hold !== null ? Math.max(1, Math.min(states.length - 1, hold)) : 1
        if (hold !== null) {
          // Run the steps up to the held frame so tracers and decals exist.
          for (let k = Math.max(1, idx - 30); k <= idx; k++) r.onStep(states[k - 1]!, states[k]!)
        }
        let acc = 0
        let last = performance.now()
        const tick = (now: number) => {
          if (stopped) return
          const dt = Math.min(0.1, (now - last) / 1000)
          intervals.push(now - last)
          last = now
          if (hold === null) {
            acc += dt * 60
            while (acc >= 1 && idx < states.length - 1) {
              acc -= 1
              idx++
              // Every sim step derives its own effects, even when one render spans several steps.
              r.onStep(states[idx - 1]!, states[idx]!)
            }
            if (idx >= states.length - 1) {
              acc = 0
              if (!api.done) {
                api.done = true
                setStatus('done')
              }
            }
          } else if (!api.done) {
            api.done = true
          }
          api.frame = idx
          r.render(states[idx - 1]!, states[idx]!, hold !== null ? 1 : acc, [])
          renders.push(r.lastRenderMs)
          const bar = r.barrel
          if (bar && bar.w >= 1) {
            if (bar.weapon > 0) misses.push(bar.miss)
            else pistolFrames++
          }
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
      delete window.__arenaView
    }
  }, [])

  return (
    <div className="grid gap-3 py-4">
      <div ref={host} className="aspect-video w-full overflow-hidden rounded-lg bg-black" data-testid="arena-stage" />
      <p className="font-mono text-xs text-muted" data-testid="arena-status">
        {status}
        {view ? ` | frame ${view.frame} | round ${view.round} | hp ${view.health} | ammo ${view.ammo} | spread ${view.spreadDeg.toFixed(2)} deg` : ''}
      </p>
    </div>
  )
}
