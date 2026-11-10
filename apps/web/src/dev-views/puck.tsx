import { useEffect, useRef, useState } from 'react'
import type { Level } from '@duelwise/core/src/product'
import { CAP_FRAMES, GOALS_TO_WIN, GRID, NO_INPUT, PUCK_EVENTS } from '@duelwise/core/src/games/puck/constants'
import { observe, resultOf } from '@duelwise/core/src/games/puck/core'
import { createBot } from '@duelwise/core/src/games/puck/bots'
import { unitToCell } from '@duelwise/core/src/games/puck/input'
import { MalletControl, fitLayout, readSafeInsets, worldToScreen, type Layout } from '../games/puck/input'
import { FixedLoop, PuckMatch } from '../games/puck/loop'
import { PuckRenderer, readTheme } from '../games/puck/render'
import '../games/puck/puck.css'

// Dev page for air hockey (game 10, internal id puck): you against Pip, phone first.
//   /dev/puck                      phone: relative drag, desktop: mouse follows the cursor
//   ?level=easy|medium|hard|champion  the hands Pip plays with (default easy)
//   ?seed=N                        the match seed
//   ?direct=1                      touch uses a direct mode (mallet above the finger) to compare the two feels
//   ?touch=1 / ?touch=0            force the phone layout on or off
//   ?autoplay=1&ff=N               a scripted hand plays you, N sim ticks per tick (e2e)
// window.__puckDev exposes the state to the e2e spec.

interface DevApi {
  ready: boolean
  frame: number
  over: boolean
  winner: number
  score: [number, number]
  phase: number
  mallet: [number, number]
  held: [number, number]
  puck: [number, number]
  landscape: boolean
  scale: number
  toScreen(wx: number, wy: number): [number, number]
  fps: number
  simMs: number
  drawMs: number
  peakSpeed: number
  paused: boolean
}
declare global {
  interface Window {
    __puckDev?: DevApi
  }
}

interface Outcome {
  winner: number | null
  score: [number, number]
}

const LEVELS: readonly Level[] = ['easy', 'medium', 'hard', 'champion']

export default function PuckDev() {
  const stage = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const devRef = useRef<HTMLDivElement>(null)
  const clockRef = useRef<HTMLSpanElement>(null)
  const [score, setScore] = useState<[number, number]>([0, 0])
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [paused, setPaused] = useState(false)
  const [dragged, setDragged] = useState(false)
  const [round, setRound] = useState(0)
  const [layout, setLayout] = useState<Layout>({ landscape: false, x: 0, y: 0, scale: 1, edgeGuard: 0 })
  const [pointer, setPointer] = useState<'touch' | 'mouse'>('mouse')
  const [size, setSize] = useState({ w: 0, h: 0 })
  const ctl = useRef<{ pause(on: boolean): void } | null>(null)

  useEffect(() => {
    const el = stage.current
    const cv = canvas.current
    if (!el || !cv) return
    const q = new URLSearchParams(window.location.search)
    const levelQ = q.get('level') as Level | null
    const level: Level = levelQ && LEVELS.includes(levelQ) ? levelQ : 'easy'
    const seed = q.has('seed') ? Number(q.get('seed')) >>> 0 : (Math.random() * 2 ** 32) >>> 0
    const direct = q.get('direct') === '1'
    const autoplay = q.get('autoplay') === '1'
    const ff = Math.max(1, Math.min(60, Number(q.get('ff') ?? 1) || 1))
    const touchQ = q.get('touch')
    const coarse = touchQ ? touchQ === '1' : window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
    setPointer(coarse ? 'touch' : 'mouse')

    const renderer = new PuckRenderer(cv, readTheme())
    const control = new MalletControl(fitLayout(el.clientWidth, el.clientHeight, coarse, readSafeInsets()), { direct, offsetPx: 84 })
    const loop = new FixedLoop()
    let match = new PuckMatch(seed, level)
    const human = autoplay ? createBot('striker', seed + 1) : null
    let humanCode = NO_INPUT
    let curLayout = fitLayout(el.clientWidth, el.clientHeight, coarse, readSafeInsets())
    let isPaused = false
    let raf = 0
    let lastScore = '0:0'
    let lastClock = -1
    let simAcc = 0
    let simN = 0
    let drawAcc = 0
    let drawN = 0
    let dtAcc = 0
    let dtN = 0
    let lastRaf = 0
    let lastHud = 0

    const api: DevApi = {
      ready: false, frame: 0, over: false, winner: -1, score: [0, 0], phase: 0, mallet: [0, 0], held: [0, 0], puck: [0, 0],
      landscape: false, scale: 1, toScreen: (wx, wy) => worldToScreen(curLayout, wx, wy),
      fps: 0, simMs: 0, drawMs: 0, peakSpeed: 0, paused: false,
    }
    window.__puckDev = api

    const fit = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      curLayout = fitLayout(w, h, coarse, readSafeInsets())
      control.setLayout(curLayout)
      renderer.resize(w, h, curLayout, window.devicePixelRatio || 1)
      setLayout(curLayout)
      setSize({ w, h })
    }

    const start = (): void => {
      match = new PuckMatch(q.has('seed') ? seed : (Math.random() * 2 ** 32) >>> 0, level)
      control.reset(match.s.m[0].x, match.s.m[0].y)
      loop.pause()
      renderer.snap(match.s, performance.now())
      humanCode = NO_INPUT
      lastScore = '0:0'
      lastClock = -1
      setScore([0, 0])
      setOutcome(null)
    }

    const tickOnce = (): void => {
      const s = match.s
      let code = control.takeCode()
      if (human) {
        if (s.frame % 2 === 0) {
          const t = human.act(observe(s, 0))
          humanCode = unitToCell(t[0]) + GRID * unitToCell(t[1])
        } else humanCode = NO_INPUT
        code = humanCode
      }
      match.tick(code)
      renderer.push(s, performance.now())
      if (s.ev & (1 << PUCK_EVENTS.goal)) navigator.vibrate?.(14)
    }

    const afterTicks = (): void => {
      const s = match.s
      const key = `${s.score[0]}:${s.score[1]}`
      if (key !== lastScore) {
        lastScore = key
        setScore([s.score[0], s.score[1]])
      }
      const left = Math.max(0, Math.ceil((CAP_FRAMES - s.frame) / 60))
      if (left !== lastClock) {
        lastClock = left
        if (clockRef.current) clockRef.current.textContent = s.sudden === 1 ? 'Next goal wins' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
      }
      if (match.over) {
        const r = resultOf(s)!
        setOutcome({ winner: r.winner, score: [s.score[0], s.score[1]] })
      }
    }

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      if (isPaused) { lastRaf = 0; return }
      if (lastRaf > 0) {
        dtAcc += now - lastRaf
        dtN++
      }
      lastRaf = now
      if (!match.over) {
        const t0 = performance.now()
        const n = loop.advance(now, () => {
          for (let k = 0; k < ff && !match.over; k++) tickOnce()
        })
        if (n > 0) {
          simAcc += (performance.now() - t0) / n
          simN++
          afterTicks()
        }
      }
      renderer.draw(loop.alpha, now, match.s)
      drawAcc += renderer.lastDrawMs
      drawN++
      if (now - lastHud > 500) {
        lastHud = now
        api.fps = dtN > 0 ? Math.round((1000 * dtN) / dtAcc) : 0
        api.simMs = simN > 0 ? simAcc / simN : 0
        api.drawMs = drawN > 0 ? drawAcc / drawN : 0
        dtAcc = dtN = simAcc = simN = drawAcc = drawN = 0
        if (devRef.current) devRef.current.textContent = `${api.fps} fps  sim ${api.simMs.toFixed(2)} ms  draw ${api.drawMs.toFixed(2)} ms\nfinger peak ${control.peakSpeed.toFixed(1)} W/s`
      }
      const s = match.s
      api.frame = s.frame; api.over = match.over; api.winner = s.winner; api.phase = s.phase
      api.score = [s.score[0], s.score[1]]
      api.mallet = [s.m[0].x, s.m[0].y]; api.held = control.target(); api.puck = [s.px, s.py]
      api.landscape = curLayout.landscape; api.scale = curLayout.scale; api.peakSpeed = control.peakSpeed; api.paused = isPaused
    }

    const setPause = (on: boolean): void => {
      if (isPaused === on || match.over) return
      isPaused = on
      api.paused = on
      loop.pause()
      control.cancelAll()
      renderer.setTouching(false)
      setPaused(on)
    }
    ctl.current = { pause: setPause }

    // Pointer events. A finger that lands on a button belongs to the button.
    const onButton = (e: Event): boolean => (e.target as Element | null)?.closest('button') != null
    const onDown = (e: PointerEvent): void => {
      if (onButton(e) || isPaused || match.over) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if (control.down(e.pointerId, e.pointerType, e.clientX, e.clientY, e.timeStamp)) {
        if (e.pointerType !== 'mouse') {
          try { el.setPointerCapture(e.pointerId) } catch { /* the browser ended this pointer */ }
          renderer.setTouching(true)
        }
        e.preventDefault()
      }
    }
    const onMove = (e: PointerEvent): void => {
      if (isPaused || match.over) return
      if (e.pointerType === 'mouse') {
        control.move(e.pointerId, 'mouse', e.clientX, e.clientY, e.timeStamp)
        return
      }
      if (!control.active(e.pointerId)) return
      const list = e.getCoalescedEvents?.() ?? []
      if (list.length > 0) for (const c of list) control.move(e.pointerId, e.pointerType, c.clientX, c.clientY, c.timeStamp)
      else control.move(e.pointerId, e.pointerType, e.clientX, e.clientY, e.timeStamp)
      setDragged(true)
      e.preventDefault()
    }
    const onUp = (e: PointerEvent): void => {
      if (control.active(e.pointerId)) renderer.setTouching(false)
      control.up(e.pointerId)
    }
    const onHidden = (): void => { if (document.hidden) setPause(true) }
    // Players switch apps (a call, the app switcher, another window): pause on blur and pagehide too, not only on a hidden tab.
    const onAway = (): void => setPause(true)
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Escape' || e.code === 'KeyP') setPause(!isPaused)
    }
    const stop = (e: Event): void => e.preventDefault()
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('lostpointercapture', onUp)
    el.addEventListener('contextmenu', stop)
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('blur', onAway)
    window.addEventListener('pagehide', onAway)
    window.addEventListener('keydown', onKey)
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    fit()
    start()
    api.ready = true
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('lostpointercapture', onUp)
      el.removeEventListener('contextmenu', stop)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('blur', onAway)
      window.removeEventListener('pagehide', onAway)
      window.removeEventListener('keydown', onKey)
      delete window.__puckDev
    }
  }, [round])

  const restart = (): void => {
    setPaused(false)
    setDragged(false)
    setRound((r) => r + 1)
  }

  const l = layout
  const stripStyle: React.CSSProperties = l.landscape
    ? { left: l.edgeGuard, top: l.y, width: Math.max(0, l.x - 8 - l.edgeGuard), height: l.scale }
    : { left: 0, top: l.y + l.scale * 2 + 8, width: size.w, height: Math.max(0, size.h - (l.y + l.scale * 2) - 8) }
  const wonByMe = outcome?.winner === 0
  const headline = !outcome ? '' : outcome.winner === null ? 'Dead level' : wonByMe ? 'You won' : 'Pip won'
  const detail = !outcome ? '' : outcome.winner === null ? `${outcome.score[0]} to ${outcome.score[1]} at the cap.` : `${Math.max(...outcome.score)} to ${Math.min(...outcome.score)}.`

  return (
    <div ref={stage} className="puck-stage" data-testid="puck-stage" data-pointer={pointer} data-landscape={l.landscape ? '' : undefined} data-phase={outcome ? 'over' : paused ? 'paused' : 'playing'}>
      <canvas ref={canvas} className="puck-canvas" data-testid="puck-canvas" aria-label="Air hockey table. Drag to move your mallet." role="img" />
      <div className="puck-hud">
        <div className="puck-score" aria-live="polite" data-testid="puck-score">
          <div className="puck-side" data-me><b>{score[0]}</b><small>You</small></div>
          <div className="puck-side" data-them><b>{score[1]}</b><small>Pip</small></div>
        </div>
        <div className="puck-mid">
          <span className="puck-clock" ref={clockRef} />
          <div ref={devRef} className="puck-dev" data-testid="puck-dev" />
        </div>
        <button type="button" className="puck-btn" onClick={() => ctl.current?.pause(true)} tabIndex={paused ? -1 : 0} aria-hidden={paused ? true : undefined} style={paused ? { visibility: 'hidden' } : undefined}>Pause</button>
      </div>
      {pointer === 'touch' && (
        <div className="puck-strip" data-hidden={dragged ? '' : undefined} style={stripStyle} aria-hidden="true">
          <div>
            <div className="puck-strip-ring"><i /></div>
            Drag here. Your mallet follows.
          </div>
        </div>
      )}
      {paused && !outcome && (
        <div className="puck-ov" role="dialog" aria-label="Paused">
          <div className="puck-card">
            <h2>Paused</h2>
            <p>First to {GOALS_TO_WIN}. Your mallet stays on your half.</p>
            <div className="row">
              <button type="button" className="puck-btn primary" onClick={() => ctl.current?.pause(false)}>Resume</button>
              <button type="button" className="puck-btn" onClick={restart}>Restart</button>
            </div>
          </div>
        </div>
      )}
      {outcome && (
        <div className="puck-ov" role="dialog" aria-label="Match over" data-testid="puck-result">
          <div className="puck-card">
            <h2>{headline}</h2>
            <p>{detail}</p>
            <div className="row">
              <button type="button" className="puck-btn primary" onClick={restart} data-testid="puck-again">Play again</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
