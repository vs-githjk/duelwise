import { OVERHEAT_FRAMES, SUPER_MAX, SURGE_MAX } from './constants'
import { EV, type Fighter } from './state'

export function gainSuper(f: Fighter, n: number): void {
  f.superMeter = Math.min(SUPER_MAX, f.superMeter + n)
}

export function gainSurge(f: Fighter, n: number): void {
  if (f.overheat > 0) return
  f.surge = Math.min(SURGE_MAX, f.surge + n)
}

/** Spending or draining to empty starts overheat: no surge actions until it ends. */
export function spendSurge(f: Fighter, n: number): void {
  if (f.overheat > 0) return
  f.surge -= n
  if (f.surge <= 0) {
    f.surge = 0
    f.overheat = OVERHEAT_FRAMES
    f.events |= EV.OVERHEAT
  }
}
