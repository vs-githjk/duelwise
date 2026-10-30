import { BTN, DIR, type FighterInput } from '@duelwise/core/src/games/fighter/input'

// Keyboard control for the fighter page. One scheme for the human and the agent: a direction (nine ways)
// and one button per frame. The page samples once per sim step; a tap shorter than a step is latched so it
// still lands. Keys are KeyboardEvent.code values, so the layout does not matter (WASD stays WASD on AZERTY).

export const ACTIONS = ['up', 'down', 'left', 'right', 'light', 'medium', 'heavy', 'special', 'surge', 'throw', 'pause'] as const
export type Action = (typeof ACTIONS)[number]
export type KeyMap = Record<Action, string[]>

export const DEFAULT_KEYS: KeyMap = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  light: ['KeyJ'],
  medium: ['KeyK'],
  heavy: ['KeyL'],
  special: ['KeyU'],
  surge: ['KeyI'],
  throw: ['Space'],
  pause: ['Escape'],
}

/** Labels for the controls overlay, in the order the keys are shown. */
export const ACTION_LABEL: Record<Action, string> = {
  up: 'Jump',
  down: 'Crouch',
  left: 'Move left',
  right: 'Move right',
  light: 'Light',
  medium: 'Medium',
  heavy: 'Heavy',
  special: 'Special',
  surge: 'Surge',
  throw: 'Throw',
  pause: 'Pause',
}

const BUTTON: Partial<Record<Action, number>> = {
  light: BTN.LIGHT,
  medium: BTN.MEDIUM,
  heavy: BTN.HEAVY,
  special: BTN.SPECIAL,
  surge: BTN.SURGE,
  throw: BTN.THROW,
}

/** Short names for key codes: "KeyW" shows as "W", "Space" as "Space". */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Arrow')) return code.slice(5)
  return code === 'Escape' ? 'Esc' : code
}

/** Moves `code` to `action` and takes it from any other action that had it, so one key never does two things. */
export function rebind(map: KeyMap, action: Action, code: string): KeyMap {
  const out = {} as KeyMap
  for (const a of ACTIONS) out[a] = a === action ? [code] : map[a].filter((c) => c !== code)
  return out
}

/** Reads a saved key map; anything malformed gives the defaults. */
export function parseKeyMap(raw: string | null): KeyMap {
  if (!raw) return DEFAULT_KEYS
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    const out = {} as KeyMap
    for (const a of ACTIONS) {
      const list = v[a]
      if (!Array.isArray(list) || !list.every((c) => typeof c === 'string')) return DEFAULT_KEYS
      out[a] = list as string[]
    }
    // Upgrade saved default maps without changing custom bindings.
    for (const a of ['up', 'down', 'left', 'right'] as const) {
      const [letter, arrow] = DEFAULT_KEYS[a]!
      if (out[a].length === 1 && out[a][0] === letter && !ACTIONS.some((other) => out[other].includes(arrow!))) out[a].push(arrow!)
    }
    return out
  } catch {
    return DEFAULT_KEYS
  }
}

const STORE = 'duelwise.fighter.keys'

export function loadKeyMap(): KeyMap {
  try {
    return parseKeyMap(localStorage.getItem(STORE))
  } catch {
    return DEFAULT_KEYS
  }
}

export function saveKeyMap(map: KeyMap): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(map))
  } catch {
    // storage unavailable: the binding lasts for this page view
  }
}

// [up, down, left, right] to the screen direction.
const DIR_OF: Record<string, number> = {
  '0000': DIR.N, '1000': DIR.U, '0100': DIR.D, '0010': DIR.L, '0001': DIR.R,
  '1010': DIR.UL, '1001': DIR.UR, '0110': DIR.DL, '0101': DIR.DR,
}

export class KeyboardInput {
  private readonly held = new Set<string>()
  private order: Action[] = []
  private latched: number = BTN.NONE
  private byCode = new Map<string, Action>()

  constructor(private map: KeyMap = DEFAULT_KEYS) {
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

  /** The action a key code is bound to, or null. */
  actionFor(code: string): Action | null {
    return this.byCode.get(code) ?? (code.startsWith("touch:") && ACTIONS.includes(code.slice(6) as Action) ? code.slice(6) as Action : null)
  }

  down(code: string): void {
    const a = this.actionFor(code)
    if (!a || this.held.has(code)) return
    this.held.add(code)
    const b = BUTTON[a]
    if (b !== undefined) {
      this.order = this.order.filter((x) => x !== a)
      this.order.push(a)
      this.latched = b
    }
  }

  up(code: string): void {
    const a = this.actionFor(code)
    this.held.delete(code)
    if (a && BUTTON[a] !== undefined && !this.isHeld(a)) this.order = this.order.filter((x) => x !== a)
  }

  /** Releases every key (the window lost focus, so no key-up will arrive). */
  blur(): void {
    this.held.clear()
    this.order = []
    this.latched = BTN.NONE
  }

  private isHeld(a: Action): boolean {
    return this.held.has(`touch:${a}`) || this.map[a].some((c) => this.held.has(c))
  }

  /** The input for the next sim step. Reading it consumes a latched tap. */
  sample(): FighterInput {
    let up = this.isHeld('up')
    let down = this.isHeld('down')
    let left = this.isHeld('left')
    let right = this.isHeld('right')
    if (left && right) left = right = false
    if (up && down) down = false
    const dir = DIR_OF[`${+up}${+down}${+left}${+right}`]!
    let btn: number = BTN.NONE
    for (let i = this.order.length - 1; i >= 0; i--) {
      const a = this.order[i]!
      if (this.isHeld(a)) {
        btn = BUTTON[a]!
        break
      }
    }
    if (btn === BTN.NONE) btn = this.latched
    this.latched = BTN.NONE
    return { dir, btn }
  }
}
