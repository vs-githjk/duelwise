import { useEffect, useState, type PointerEvent } from 'react'
import './touch.css'

export function stickDirections(x: number, y: number): { up: boolean; down: boolean; left: boolean; right: boolean } {
  const length = Math.hypot(x, y)
  if (length < 0.2) return { up: false, down: false, left: false, right: false }
  const threshold = length * 0.38
  return { up: y < -threshold, down: y > threshold, left: x < -threshold, right: x > threshold }
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
    const prevent = (e: TouchEvent) => { if (e.touches.length > 1) e.preventDefault() }
    document.addEventListener('touchmove', prevent, { passive: false })
    return () => { document.body.style.overflow = old; document.removeEventListener('touchmove', prevent) }
  }, [active])
}

type Props = { game: 'fighter' | 'arena'; action: (name: string, down: boolean) => void; aim?: (dx: number, dy: number) => void; pause: () => void }
export function TouchControls({ game, action, aim, pause }: Props) {
  const [stick, setStick] = useState({ x: 0, y: 0 })
  const updateStick = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2)
    const y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2)
    setStick({ x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) })
    const d = stickDirections(x, y)
    action(game === 'arena' ? 'forward' : 'up', d.up); action(game === 'arena' ? 'back' : 'down', d.down)
    action('left', d.left); action('right', d.right)
  }
  const releaseStick = () => { setStick({ x: 0, y: 0 }); for (const a of [game === 'arena' ? 'forward' : 'up', game === 'arena' ? 'back' : 'down', 'left', 'right']) action(a, false) }
  const names = game === 'fighter' ? ['light', 'medium', 'heavy', 'special', 'surge', 'throw'] : ['fire', 'jump', 'crouch', 'reload', 'scoreboard']
  return <div className="touch-controls" data-testid={`${game}-touch-controls`} data-no-capture>
    {game === 'arena' && <div className="touch-aim" aria-label="Drag to aim" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.dataset.x = String(e.clientX); e.currentTarget.dataset.y = String(e.clientY) }} onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const x = Number(e.currentTarget.dataset.x); const y = Number(e.currentTarget.dataset.y); aim?.(e.clientX - x, e.clientY - y); e.currentTarget.dataset.x = String(e.clientX); e.currentTarget.dataset.y = String(e.clientY) }} />}
    <div className="touch-rotate">Rotate for the best view</div>
    <button className="touch-pause" type="button" onClick={pause}>Pause</button>
    <div className="touch-stick" aria-label="Movement stick" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); updateStick(e) }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) updateStick(e) }} onPointerUp={releaseStick} onPointerCancel={releaseStick} onLostPointerCapture={releaseStick}>
      <span style={{ transform: `translate(${stick.x * 25}px, ${stick.y * 25}px)` }} />
    </div>
    <div className="touch-buttons">{names.map(name => <button key={name} type="button" aria-label={name} onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); action(name, true) }} onPointerUp={() => action(name, false)} onPointerCancel={() => action(name, false)} onLostPointerCapture={() => action(name, false)}>{name}</button>)}</div>
  </div>
}
