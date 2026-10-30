import { HUMAN_YAW_MAX, MOVE, NEUTRAL_INPUT, PITCH_MAX_DELTA, type ArenaInput } from '@duelwise/core/src/games/arena/input'
import { PITCH_LIMIT } from '@duelwise/core/src/games/arena/core'

// Keyboard and mouse control for the arena page. One scheme for the human and the agent: the same
// ArenaInput the sim takes (nine move directions, five buttons, a yaw and pitch turn per frame, a buy
// choice). The page samples once per sim step. Keys are KeyboardEvent.code values, so the layout does
// not matter. Mouse movement is turned into angle units (8192 per turn) with the fraction carried to the
// next frame, so a slow drag is not lost to rounding. Each sim step takes the whole turn summed since the
// last one (up to HUMAN_YAW_MAX, 45 degrees a frame); anything past that limit waits for the next step and
// nothing is ever dropped (R30: the old 255 limit with a 3 frame backlog cut a 90 degree flick to 67).
// The camera reads pendingTurn() every rendered frame, so the view follows the mouse without waiting for the 60 Hz sim.

export const ACTIONS = ['forward', 'back', 'left', 'right', 'jump', 'crouch', 'walk', 'reload', 'scoreboard', 'pause', 'fire'] as const
export type Action = (typeof ACTIONS)[number]
export type KeyMap = Record<Action, string[]>

export const DEFAULT_KEYS: KeyMap = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['KeyC', 'ControlLeft'],
  walk: ['ShiftLeft'],
  reload: ['KeyR'],
  scoreboard: ['Tab'],
  pause: ['Escape'],
  // F, under the left hand, so a trackpad player does not have to click while moving. The left mouse button still fires.
  fire: ['KeyF'],
}

export const ACTION_LABEL: Record<Action, string> = {
  forward: 'Move forward',
  back: 'Move back',
  left: 'Strafe left',
  right: 'Strafe right',
  jump: 'Jump',
  crouch: 'Crouch',
  walk: 'Walk quietly (hold)',
  reload: 'Reload',
  scoreboard: 'Scoreboard (hold)',
  pause: 'Pause',
  fire: 'Fire (or left click)',
}

/** Short names for key codes: "KeyW" shows as "W". */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Arrow')) return code.slice(5)
  if (code === 'ControlLeft') return 'Ctrl'
  if (code === 'ShiftLeft') return 'Shift'
  return code === 'Escape' ? 'Esc' : code
}

/** Moves `code` to `action` and takes it from any other action that had it, so one key never does two things. */
export function rebind(map: KeyMap, action: Action, code: string): KeyMap {
  const out = {} as KeyMap
  for (const a of ACTIONS) out[a] = a === action ? [code] : map[a].filter((c) => c !== code)
  return out
}

export function parseKeyMap(raw: string | null): KeyMap {
  if (!raw) return DEFAULT_KEYS
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    const out = {} as KeyMap
    for (const a of ACTIONS) {
      // A map saved before an action existed (Fire) takes that action's default instead of throwing the whole map away.
      const list = v[a] === undefined ? DEFAULT_KEYS[a] : v[a]
      if (!Array.isArray(list) || !list.every((c) => typeof c === 'string')) return DEFAULT_KEYS
      out[a] = list as string[]
    }
    return out
  } catch {
    return DEFAULT_KEYS
  }
}

// ---------------------------------------------------------------- settings

export type CrosshairStyle = 'classic' | 'dot' | 'cross'

export interface ArenaSettings {
  /** Mouse sensitivity multiplier: one mouse count turns the view by 0.022 degrees times this. */
  sensitivity: number
  /** Mouse DPI, only used to show centimetres per 360 degrees. */
  dpi: number
  crosshair: { style: CrosshairStyle; color: string; size: number; gap: number; thickness: number; outline: boolean }
  hitMarker: boolean
}

export const DEFAULT_SETTINGS: ArenaSettings = {
  sensitivity: 2,
  dpi: 800,
  crosshair: { style: 'classic', color: '#9cff5a', size: 8, gap: 4, thickness: 2, outline: true },
  hitMarker: true,
}

export const SENSITIVITY_RANGE = { min: 0.1, max: 10 }
export const CROSSHAIR_COLORS: readonly string[] = ['#9cff5a', '#ffffff', '#ffe14d', '#4de3ff', '#ff6bd5']
/** Degrees one mouse count turns the view at sensitivity 1. */
export const DEG_PER_COUNT = 0.022
export const UNITS_PER_DEG = 8192 / 360

/** Centimetres of mouse travel for a full turn. */
export function cmPer360(s: Pick<ArenaSettings, 'sensitivity' | 'dpi'>): number {
  return (360 / (DEG_PER_COUNT * s.sensitivity) / s.dpi) * 2.54
}

const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

export function parseSettings(raw: string | null): ArenaSettings {
  if (!raw) return DEFAULT_SETTINGS
  try {
    const v = JSON.parse(raw) as Partial<ArenaSettings> & { crosshair?: Partial<ArenaSettings['crosshair']> }
    const d = DEFAULT_SETTINGS
    const c: Partial<ArenaSettings['crosshair']> = v.crosshair ?? {}
    const style = c.style === 'dot' || c.style === 'cross' || c.style === 'classic' ? c.style : d.crosshair.style
    const color = typeof c.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : d.crosshair.color
    return {
      sensitivity: num(v.sensitivity, SENSITIVITY_RANGE.min, SENSITIVITY_RANGE.max, d.sensitivity),
      dpi: num(v.dpi, 100, 32000, d.dpi),
      crosshair: {
        style,
        color,
        size: num(c.size, 1, 30, d.crosshair.size),
        gap: num(c.gap, 0, 20, d.crosshair.gap),
        thickness: num(c.thickness, 1, 6, d.crosshair.thickness),
        outline: typeof c.outline === 'boolean' ? c.outline : d.crosshair.outline,
      },
      hitMarker: typeof v.hitMarker === 'boolean' ? v.hitMarker : d.hitMarker,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

const KEYS_STORE = 'duelwise.arena.keys'
const SETTINGS_STORE = 'duelwise.arena.settings'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable: the choice lasts for this page view
  }
}

export const loadKeyMap = (): KeyMap => parseKeyMap(read(KEYS_STORE))
export const saveKeyMap = (m: KeyMap): void => write(KEYS_STORE, JSON.stringify(m))
export const loadSettings = (): ArenaSettings => parseSettings(read(SETTINGS_STORE))
export const saveSettings = (s: ArenaSettings): void => write(SETTINGS_STORE, JSON.stringify(s))

// ---------------------------------------------------------------- sampler

// [forward, back, left, right] to the sim's move index (0 neutral, then clockwise from forward).
const MOVE_OF: Record<string, number> = {
  '0000': MOVE.N, '1000': MOVE.F, '0100': MOVE.B, '0010': MOVE.L, '0001': MOVE.R,
  '1010': MOVE.FL, '1001': MOVE.FR, '0110': MOVE.BL, '0101': MOVE.BR,
}

export class ArenaInputSampler {
  private readonly held = new Set<string>()
  private byCode = new Map<string, Action>()
  private touchLatched = new Set<Action>()
  private fireHeld = false
  private fireLatched = false
  private accYaw = 0
  private accPitch = 0
  private pitchNow = 0
  private buy = 0

  constructor(private map: KeyMap = DEFAULT_KEYS, private settings: ArenaSettings = DEFAULT_SETTINGS) {
    this.index()
  }

  private index(): void {
    this.byCode.clear()
    for (const a of ACTIONS) for (const c of this.map[a]) this.byCode.set(c, a)
  }

  setMap(map: KeyMap): void {
    this.map = map
    this.index()
    this.blur()
  }

  setSettings(s: ArenaSettings): void {
    this.settings = s
  }

  actionFor(code: string): Action | null {
    return this.byCode.get(code) ?? null
  }

  down(code: string): void {
    if (this.byCode.has(code) || (code.startsWith("touch:") && ACTIONS.includes(code.slice(6) as Action))) {
      if (!this.held.has(code) && (code === 'touch:jump' || code === 'touch:reload')) this.touchLatched.add(code.slice(6) as Action)
      // A tap of the fire key shorter than one sim step still fires once, like a click.
      if (!this.held.has(code) && this.byCode.get(code) === 'fire') this.fireLatched = true
      this.held.add(code)
    }
  }

  up(code: string): void {
    this.held.delete(code)
  }

  isHeld(a: Action): boolean {
    return this.held.has(`touch:${a}`) || this.map[a].some((c) => this.held.has(c))
  }

  mouseDown(button: number): void {
    if (button !== 0) return
    this.fireHeld = true
    this.fireLatched = true
  }

  mouseUp(button: number): void {
    if (button === 0) this.fireHeld = false
  }

  /** Raw mouse counts from a pointer-locked mousemove event. Right and down are positive. */
  mouseMove(dx: number, dy: number): void {
    const k = DEG_PER_COUNT * this.settings.sensitivity * UNITS_PER_DEG
    this.accYaw -= dx * k // the sim's yaw grows counter-clockwise, so moving right turns it down
    this.accPitch -= dy * k // positive pitch looks up
    // The sim clamps pitch at the limit, so a backlog past the room left would only cancel the next move the other way.
    this.accPitch = Math.max(-PITCH_LIMIT - this.pitchNow, Math.min(PITCH_LIMIT - this.pitchNow, this.accPitch))
  }

  /** The human seat's pitch in the sim right now (angle units); the page sets it before each mouse move and each sample. */
  setPitch(pitch: number): void {
    this.pitchNow = pitch
    this.accPitch = Math.max(-PITCH_LIMIT - pitch, Math.min(PITCH_LIMIT - pitch, this.accPitch))
  }

  /** The turn (angle units, sim signs) that has been moved but not yet sent to the sim: the camera adds it to the sim's view. */
  pendingTurn(): { yaw: number; pitch: number } {
    return { yaw: this.accYaw, pitch: this.accPitch }
  }

  /** A buy choice (1 Ridgeline, 2 Carbine, 3 armor) for the next step. */
  queueBuy(choice: number): void {
    this.buy = choice
  }

  /** Releases every key and button (the window lost focus or the pointer lock ended, so no key-up will arrive). */
  blur(): void {
    this.held.clear()
    this.touchLatched.clear()
    this.fireHeld = false
    this.fireLatched = false
    this.accYaw = 0
    this.accPitch = 0
  }

  /** The input for the next sim step. Reading it consumes a latched tap, the turn it applies and the queued buy. */
  sample(): ArenaInput {
    let f = this.isHeld('forward')
    let b = this.isHeld('back')
    let l = this.isHeld('left')
    let r = this.isHeld('right')
    if (f && b) f = b = false
    if (l && r) l = r = false
    const yaw = Math.max(-HUMAN_YAW_MAX, Math.min(HUMAN_YAW_MAX, Math.round(this.accYaw)))
    const pitch = Math.max(-PITCH_MAX_DELTA, Math.min(PITCH_MAX_DELTA, Math.round(this.accPitch)))
    this.accYaw -= yaw
    this.accPitch -= pitch
    const fire = this.fireHeld || this.fireLatched || this.isHeld('fire') ? 1 : 0
    this.fireLatched = false
    const buy = this.buy
    this.buy = 0
    const jump = this.isHeld('jump') || this.touchLatched.has('jump')
    const reload = this.isHeld('reload') || this.touchLatched.has('reload')
    this.touchLatched.clear()
    return {
      ...NEUTRAL_INPUT,
      move: MOVE_OF[`${+f}${+b}${+l}${+r}`]!,
      walk: +this.isHeld('walk'),
      crouch: +this.isHeld('crouch'),
      jump: +jump,
      reload: +reload,
      fire,
      yaw,
      pitch,
      buy,
    }
  }
}
