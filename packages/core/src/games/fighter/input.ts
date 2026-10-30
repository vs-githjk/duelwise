// One control scheme for humans and agents: nine directions (neutral plus eight) and one
// button state per frame. Direction codes are absolute screen directions; "forward" and
// "back" follow the fighter's facing.

export const DIR = { N: 0, U: 1, UR: 2, R: 3, DR: 4, D: 5, DL: 6, L: 7, UL: 8 } as const
export const BTN = { NONE: 0, LIGHT: 1, MEDIUM: 2, HEAVY: 3, SPECIAL: 4, SURGE: 5, THROW: 6 } as const

export interface FighterInput {
  dir: number
  btn: number
}

export const N_DIRS = 9
export const N_BUTTONS = 7
export const N_ACTIONS = N_DIRS * N_BUTTONS

export const NEUTRAL_INPUT: Readonly<FighterInput> = { dir: 0, btn: 0 }

export function packInput(i: FighterInput): number {
  return i.btn * N_DIRS + i.dir
}

export function unpackInput(n: number): FighterInput {
  if (!Number.isInteger(n) || n < 0 || n >= N_ACTIONS) throw new RangeError('fighter: bad action ' + n)
  return { dir: n % N_DIRS, btn: (n - (n % N_DIRS)) / N_DIRS }
}

const mk = (list: number[]): Uint8Array => {
  const a = new Uint8Array(N_DIRS)
  for (const d of list) a[d] = 1
  return a
}
export const HAS_RIGHT = mk([DIR.UR, DIR.R, DIR.DR])
export const HAS_LEFT = mk([DIR.UL, DIR.L, DIR.DL])
export const HAS_UP = mk([DIR.U, DIR.UR, DIR.UL])
export const HAS_DOWN = mk([DIR.D, DIR.DR, DIR.DL])

const MIRROR_DIR = [0, 1, 8, 7, 6, 5, 4, 3, 2]
/** Mirrors left and right; used by the symmetry tests and by flipped views. */
export function mirrorDir(dir: number): number {
  return MIRROR_DIR[dir]!
}
export function mirrorInput(n: number): number {
  const i = unpackInput(n)
  return i.btn * N_DIRS + MIRROR_DIR[i.dir]!
}
