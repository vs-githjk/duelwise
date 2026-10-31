import { useEffect, useRef, useState, type PointerEvent } from 'react'
import './touch.css'

export function stickDirections(x: number, y: number): { up: boolean; down: boolean; left: boolean; right: boolean } {
  const length = Math.hypot(x, y)
  if (length < 0.2) return { up: false, down: false, left: false, right: false }
  const threshold = length * 0.38
  return { up: y < -threshold, down: y > threshold, left: x < -threshold, right: x > threshold }
}

export type StickDirs = ReturnType<typeof stickDirections>
const NO_DIRS: StickDirs = { up: false, down: false, left: false, right: false }

/**
 * The fighter's stick. Up is a jump and down is a crouch that stops the walk, so a thumb drifting off level must keep walking: the sideways
 * band is wide, and up or down needs a clear push. `prev` adds hysteresis, so a thumb resting on a threshold does not flicker. That matters
 * because the sim reads a quick release and re-press as a double tap, which is a dash.
 */
export function fighterStickDirections(x: number, y: number, prev: StickDirs = NO_DIRS): StickDirs {
  const length = Math.hypot(x, y)
  const moving = prev.up || prev.down || prev.left || prev.right
  if (length < (moving ? 0.16 : 0.26)) return NO_DIRS
  return {
    up: y < -length * (prev.up ? 0.5 : 0.64),
    down: y > length * (prev.down ? 0.6 : 0.77),
    left: x < -length * (prev.left ? 0.26 : 0.36),
    right: x > length * (prev.right ? 0.26 : 0.36),
  }
}

export function useTouchDevice(): boolean {
  const [touch, setTouch] = useState(false)
  useEffect(() => {
    const mq = matchMedia('(pointer: coarse)')
    const update = () => setTouch(mq.matches || navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches)
    update(); mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return touch
}

export function usePlayViewport(active: boolean) {
  useEffect(() => {
    if (!active) return
    const old = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Two fingers never pinch the page, and a thumb on the controls is never taken by the browser for a scroll or a swipe.
    const prevent = (e: TouchEvent) => { if (e.touches.length > 1 || (e.target instanceof Element && e.target.closest('.touch-controls'))) e.preventDefault() }
    document.addEventListener('touchmove', prevent, { passive: false })
    return () => { document.body.style.overflow = old; document.removeEventListener('touchmove', prevent) }
  }, [active])
}

type Props = { game: 'fighter' | 'arena'; action: (name: string, down: boolean) => void; aim?: (dx: number, dy: number) => void; pause: () => void }

function capture(el: Element, pointerId: number) {
  // A pointer can already be gone by the time its press is handled, and the press must still land.
  try { el.setPointerCapture(pointerId) } catch { /* the browser ended this pointer */ }
}

// Fighter buttons: the three plain attacks sit on the bottom row, nearest the thumb.
const FIGHTER_BUTTONS = ['special', 'surge', 'throw', 'light', 'medium', 'heavy']
const ARENA_BUTTONS = ['fire', 'jump', 'crouch', 'reload', 'scoreboard']

export function TouchControls({ game, action, aim, pause }: Props) {
  const actionRef = useRef(action)
  actionRef.current = action
  const stickPointer = useRef<number | null>(null)
  const dirs = useRef<StickDirs>(NO_DIRS)
  const knob = useRef<HTMLSpanElement>(null)
  const buttonPointers = useRef(new Map<string, number>())
  const dirActions = game === 'arena' ? ['forward', 'back', 'left', 'right'] : ['up', 'down', 'left', 'right']
  const send = (d: StickDirs) => {
    const [a, b, c, e] = dirActions as [string, string, string, string]
    actionRef.current(a, d.up); actionRef.current(b, d.down); actionRef.current(c, d.left); actionRef.current(e, d.right)
  }
  const updateStick = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2)
    const y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2)
    const travel = r.width * 0.22
    if (knob.current) knob.current.style.transform = `translate(${Math.max(-1, Math.min(1, x)) * travel}px, ${Math.max(-1, Math.min(1, y)) * travel}px)`
    dirs.current = game === 'fighter' ? fighterStickDirections(x, y, dirs.current) : stickDirections(x, y)
    send(dirs.current)
  }
  const releaseStick = () => {
    stickPointer.current = null
    dirs.current = NO_DIRS
    if (knob.current) knob.current.style.transform = ''
    send(NO_DIRS)
  }
  const onStickDown = (e: PointerEvent<HTMLDivElement>) => {
    // One thumb owns the stick; a second finger on it changes nothing. A dead owner (its release never came) gives way, so the stick can never go numb.
    if (stickPointer.current !== null && e.currentTarget.hasPointerCapture(stickPointer.current)) return
    stickPointer.current = e.pointerId
    capture(e.currentTarget, e.pointerId)
    updateStick(e)
  }
  const onStickEnd = (e: PointerEvent<HTMLDivElement>) => { if (e.pointerId === stickPointer.current) releaseStick() }
  const pressButton = (e: PointerEvent<HTMLButtonElement>, name: string) => {
    e.preventDefault()
    if (buttonPointers.current.has(name)) return
    buttonPointers.current.set(name, e.pointerId)
    capture(e.currentTarget, e.pointerId)
    e.currentTarget.dataset.pressed = ''
    actionRef.current(name, true)
  }
  const releaseButton = (e: PointerEvent<HTMLButtonElement>, name: string) => {
    if (buttonPointers.current.get(name) !== e.pointerId) return
    buttonPointers.current.delete(name)
    delete e.currentTarget.dataset.pressed
    actionRef.current(name, false)
  }
  // Leaving the screen with a finger down sends no pointer event, so nothing may stay held behind it.
  useEffect(() => () => {
    if (stickPointer.current !== null) { stickPointer.current = null; send(NO_DIRS) }
    for (const name of buttonPointers.current.keys()) actionRef.current(name, false)
    buttonPointers.current.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const names = game === 'fighter' ? FIGHTER_BUTTONS : ARENA_BUTTONS
  return <div className={`touch-controls touch-${game}`} data-testid={`${game}-touch-controls`} data-no-capture onContextMenu={e => e.preventDefault()}>
    {game === 'arena' && <div className="touch-aim" aria-label="Drag to aim" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.dataset.x = String(e.clientX); e.currentTarget.dataset.y = String(e.clientY) }} onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const x = Number(e.currentTarget.dataset.x); const y = Number(e.currentTarget.dataset.y); aim?.(e.clientX - x, e.clientY - y); e.currentTarget.dataset.x = String(e.clientX); e.currentTarget.dataset.y = String(e.clientY) }} />}
    <button className="touch-pause" type="button" onClick={pause}>Pause</button>
    <div className="touch-stick" aria-label="Movement stick" onPointerDown={onStickDown} onPointerMove={e => { if (e.pointerId === stickPointer.current) updateStick(e) }} onPointerUp={onStickEnd} onPointerCancel={onStickEnd} onLostPointerCapture={onStickEnd}>
      {game === 'fighter' && <svg className="touch-stick-hints" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path d="M42 16 50 8l8 8M42 84l8 8 8-8M16 42l-8 8 8 8M84 42l8 8-8 8" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      <span ref={knob} />
    </div>
    <div className="touch-buttons">{names.map(name => <button key={name} type="button" aria-label={name} data-move={name} onPointerDown={e => pressButton(e, name)} onPointerUp={e => releaseButton(e, name)} onPointerCancel={e => releaseButton(e, name)} onLostPointerCapture={e => releaseButton(e, name)}>{name}</button>)}</div>
  </div>
}
