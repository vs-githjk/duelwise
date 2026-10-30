// One control scheme for humans and agents: a single integer per seat per frame, 0 is neutral.
// Mixed radix: move (9) + 9 * (flags (32) + 32 * (pitch index (255) + 255 * (yaw index (2049) + 2049 * buy (8)))).
// Yaw and pitch deltas are stored modulo their range so that a zero delta is index 0.

export const MOVE = { N: 0, F: 1, FR: 2, R: 3, BR: 4, B: 5, BL: 6, L: 7, FL: 8 } as const

export interface ArenaInput {
  /** 0 neutral, then clockwise from forward: F, FR, R, BR, B, BL, L, FL. */
  move: number
  walk: number
  crouch: number
  jump: number
  fire: number
  reload: number
  /** Yaw delta in angle units (8192 per turn), -1024..1024 (agents and bots stay within YAW_MAX, 255). */
  yaw: number
  /** Pitch delta in angle units, -127..127, positive looks up. */
  pitch: number
  /** Buy choice, only used in the buy phase: 0 none, 1 rifle, 2 carbine, 3 armor. */
  buy: number
}

export const NEUTRAL_INPUT: Readonly<ArenaInput> = { move: 0, walk: 0, crouch: 0, jump: 0, fire: 0, reload: 0, yaw: 0, pitch: 0, buy: 0 }

export const N_MOVES = 9
/** The most an agent or bot turns in one sim frame (its policy heads and the limiter work in this range). */
export const YAW_MAX = 255
/**
 * The most the sim accepts for one frame of a human's yaw: 1024 units is 45 degrees a frame, 2,700 degrees a
 * second, more than any flick (R30: a 255 cap cut a 90 degree flick in 60 ms to 67 degrees). The packed input
 * still fits an int32 (N_ACTIONS is about 1.2e9).
 */
export const HUMAN_YAW_MAX = 1024
export const PITCH_MAX_DELTA = 127
const N_FLAGS = 32
const N_YAW = 2 * HUMAN_YAW_MAX + 1
const N_PITCH = 2 * PITCH_MAX_DELTA + 1
export const N_BUYS = 8
export const N_ACTIONS = N_MOVES * N_FLAGS * N_PITCH * N_YAW * N_BUYS

function flag(name: string, v: number): number {
  if (v !== 0 && v !== 1) throw new RangeError(`arena: ${name} must be 0 or 1, got ${v}`)
  return v
}

export function packInput(i: ArenaInput): number {
  if (!Number.isInteger(i.move) || i.move < 0 || i.move >= N_MOVES) throw new RangeError('arena: bad move ' + i.move)
  if (!Number.isInteger(i.yaw) || i.yaw < -HUMAN_YAW_MAX || i.yaw > HUMAN_YAW_MAX) throw new RangeError('arena: bad yaw delta ' + i.yaw)
  if (!Number.isInteger(i.pitch) || i.pitch < -PITCH_MAX_DELTA || i.pitch > PITCH_MAX_DELTA) throw new RangeError('arena: bad pitch delta ' + i.pitch)
  if (!Number.isInteger(i.buy) || i.buy < 0 || i.buy >= N_BUYS) throw new RangeError('arena: bad buy ' + i.buy)
  const flags = flag('walk', i.walk) + 2 * flag('crouch', i.crouch) + 4 * flag('jump', i.jump) + 8 * flag('fire', i.fire) + 16 * flag('reload', i.reload)
  const yi = (i.yaw + N_YAW) % N_YAW
  const pi = (i.pitch + N_PITCH) % N_PITCH
  return i.move + N_MOVES * (flags + N_FLAGS * (pi + N_PITCH * (yi + N_YAW * i.buy)))
}

/** Allocation-free decode target. */
export interface InputScratch {
  move: number
  walk: number
  crouch: number
  jump: number
  fire: number
  reload: number
  yaw: number
  pitch: number
  buy: number
}

export function makeScratch(): InputScratch {
  return { move: 0, walk: 0, crouch: 0, jump: 0, fire: 0, reload: 0, yaw: 0, pitch: 0, buy: 0 }
}

export function decodeInto(n: number, o: InputScratch): void {
  let r = n % N_MOVES
  o.move = r
  let q = (n - r) / N_MOVES
  r = q % N_FLAGS
  o.walk = r & 1
  o.crouch = (r >> 1) & 1
  o.jump = (r >> 2) & 1
  o.fire = (r >> 3) & 1
  o.reload = (r >> 4) & 1
  q = (q - r) / N_FLAGS
  r = q % N_PITCH
  o.pitch = r > PITCH_MAX_DELTA ? r - N_PITCH : r
  q = (q - r) / N_PITCH
  r = q % N_YAW
  o.yaw = r > HUMAN_YAW_MAX ? r - N_YAW : r
  o.buy = (q - r) / N_YAW
}

export function unpackInput(n: number): ArenaInput {
  if (!Number.isInteger(n) || n < 0 || n >= N_ACTIONS) throw new RangeError('arena: bad action ' + n)
  const o = makeScratch()
  decodeInto(n, o)
  return { ...o }
}
