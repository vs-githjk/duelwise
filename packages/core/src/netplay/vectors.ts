import { stepPacked as arenaStep, createState as arenaCreate } from '../games/arena/core'
import { HUMAN_YAW_MAX, PITCH_MAX_DELTA, packInput as arenaPack } from '../games/arena/input'
import { hashArenaState } from '../games/arena/state'
import { stepPacked as fighterStep } from '../games/fighter/core'
import { N_ACTIONS as FIGHTER_ACTIONS } from '../games/fighter/input'
import { createState as fighterCreate, hashFighterState } from '../games/fighter/state'
import { GRID, NO_INPUT, PUCK_MAX_SPEED } from '../games/puck/constants'
import { stepState as puckStep } from '../games/puck/core'
import { createState as puckCreate, hashPuckState } from '../games/puck/state'
import { fnv1a64 } from '../hash'
import { makeRng } from '../rng'

// The determinism gate for rollback netcode (slice 2, S4). Nine fixed input logs, three for each realtime game. A log is a pure function of
// (kind, seed, frame): it never reads the sim, so every engine feeds the sim exactly the same codes, and the only thing that can differ is
// the sim's own arithmetic. Randomness comes from makeRng (integer maths), so the logs themselves cannot drift between engines.
// The hash after the last frame, and a trace of the hashes every TRACE_EVERY frames, must be equal in Bun, Chromium and WebKit.

export type NetGame = 'fighter' | 'arena' | 'puck'
export type LogKind = 'mash' | 'hold' | 'long' | 'spin' | 'strafe' | 'mixed' | 'sweep' | 'corners' | 'fast'

export interface NetVector {
  id: string
  game: NetGame
  kind: LogKind
  seed: number
  frames: number
}

export const TRACE_EVERY = 500

export const NET_VECTORS: NetVector[] = [
  { id: 'fighter-mash', game: 'fighter', kind: 'mash', seed: 101, frames: 3000 },
  { id: 'fighter-hold', game: 'fighter', kind: 'hold', seed: 102, frames: 9000 },
  { id: 'fighter-long', game: 'fighter', kind: 'long', seed: 103, frames: 20000 },
  { id: 'arena-spin', game: 'arena', kind: 'spin', seed: 201, frames: 3000 },
  { id: 'arena-strafe', game: 'arena', kind: 'strafe', seed: 202, frames: 9000 },
  { id: 'arena-mixed', game: 'arena', kind: 'mixed', seed: 203, frames: 20000 },
  { id: 'puck-sweep', game: 'puck', kind: 'sweep', seed: 301, frames: 3000 },
  { id: 'puck-corners', game: 'puck', kind: 'corners', seed: 302, frames: 9000 },
  { id: 'puck-fast', game: 'puck', kind: 'fast', seed: 303, frames: 20000 },
]

export interface NetResult {
  /** Frames actually stepped (a match can end before the log does). */
  frames: number
  /** Hash of the final state. */
  hash: string
  /** Hash over the state hashes taken every TRACE_EVERY frames, so a divergence cannot hide behind a re-converged end. */
  trace: string
  /** A rough count of things that happened (hits, shots, goals, damage), to show the log does real work. */
  activity: number
  /** Frames on which an input sat at an extreme of its range (arena aim at 1024, puck mallet target in a far corner). */
  extremes: number
}

/** One seat's code source: a held value that changes at random intervals, per kind. Pure in (kind, seed). */
interface Source {
  next(frame: number): number
  extremes: number
}

const pick = <T>(rng: ReturnType<typeof makeRng>, list: readonly T[]): T => list[rng.int(list.length)]!

function fighterSource(kind: LogKind, seed: number): Source {
  const rng = makeRng(seed)
  let held = 0
  let until = 0
  const src: Source = {
    extremes: 0,
    next(frame) {
      if (frame >= until) {
        const dir = rng.int(9)
        const btn = rng.int(4) === 0 ? 0 : rng.int(7)
        held = btn * 9 + dir
        // mash: new code every 2 to 5 frames; hold: 8 to 30; long: a mix.
        const len = kind === 'mash' ? 2 + rng.int(4) : kind === 'hold' ? 8 + rng.int(23) : rng.int(3) === 0 ? 2 + rng.int(4) : 6 + rng.int(40)
        until = frame + len
      }
      return held % FIGHTER_ACTIONS
    },
  }
  return src
}

function arenaSource(kind: LogKind, seed: number): Source {
  const rng = makeRng(seed)
  let move = 0
  let flags = [0, 0, 0, 0, 0]
  let yaw = 0
  let pitch = 0
  let until = 0
  let sign = 1
  const src: Source = {
    extremes: 0,
    next(frame) {
      const buy = frame < 300 ? 1 + rng.int(3) : 0
      if (frame >= until) {
        move = rng.int(9)
        flags = [rng.int(2), rng.int(5) === 0 ? 1 : 0, rng.int(6) === 0 ? 1 : 0, rng.int(2), rng.int(40) === 0 ? 1 : 0]
        until = frame + 4 + rng.int(kind === 'strafe' ? 40 : 20)
        sign = rng.int(2) === 0 ? -1 : 1
      }
      if (kind === 'spin') {
        // The aim at its extreme every frame, the direction flipping now and then.
        yaw = sign * HUMAN_YAW_MAX
        pitch = (frame % 7 < 3 ? 1 : -1) * PITCH_MAX_DELTA
      } else if (kind === 'strafe') {
        yaw = rng.int(9) === 0 ? sign * (200 + rng.int(300)) : rng.int(31) - 15
        pitch = rng.int(9) - 4
      } else {
        const r = rng.int(10)
        yaw = r === 0 ? sign * HUMAN_YAW_MAX : r < 4 ? rng.int(2 * 255 + 1) - 255 : rng.int(41) - 20
        pitch = r === 0 ? sign * PITCH_MAX_DELTA : rng.int(31) - 15
      }
      if (Math.abs(yaw) === HUMAN_YAW_MAX || Math.abs(pitch) === PITCH_MAX_DELTA) src.extremes++
      return arenaPack({ move, walk: flags[0]!, crouch: flags[1]!, jump: flags[2]!, fire: flags[3]!, reload: flags[4]!, yaw, pitch, buy })
    },
  }
  return src
}

const FAR = [0, 1, GRID - 2, GRID - 1] as const
const cell = (x: number, y: number): number => x + GRID * y

function puckSource(kind: LogKind, seed: number, seat: 0 | 1): Source {
  const rng = makeRng(seed * 2 + seat + 1)
  let held = NO_INPUT
  let until = 0
  const src: Source = {
    extremes: 0,
    next(frame) {
      if (frame >= until) {
        if (kind === 'sweep') {
          // Slow sweeps back and forth across the own half.
          const x = rng.int(GRID)
          const y = rng.int(GRID)
          held = cell(x, y)
          until = frame + 10 + rng.int(40)
        } else if (kind === 'corners') {
          // Far corners and edges, held for a few frames: the largest jumps the grid allows, so the mallet runs at its speed limit.
          held = cell(pick(rng, FAR), pick(rng, FAR))
          until = frame + 3 + rng.int(12)
        } else {
          // Alternating far points every 2 to 4 frames, with a pause now and then: mallet and puck at their top speeds, bounces and double hits.
          held = rng.int(12) === 0 ? NO_INPUT : cell(pick(rng, FAR), rng.int(GRID))
          until = frame + 2 + rng.int(3)
        }
      }
      if (held !== NO_INPUT) {
        const x = held % GRID
        const y = (held - x) / GRID
        if ((x === 0 || x === GRID - 1) && (y === 0 || y === GRID - 1)) src.extremes++
      }
      return held
    },
  }
  return src
}

function traceOf(hashes: string[]): string {
  return fnv1a64(hashes.join(','))
}

/** The two seats' code sources for a vector, as arrays of `frames` codes each (for the rollback tests, which feed the same logs over a fake network). */
export function vectorCodes(v: NetVector, frames = v.frames): [number[], number[]] {
  const a = v.game === 'fighter' ? fighterSource(v.kind, v.seed) : v.game === 'arena' ? arenaSource(v.kind, v.seed) : puckSource(v.kind, v.seed, 0)
  const b = v.game === 'fighter' ? fighterSource(v.kind, v.seed + 7919) : v.game === 'arena' ? arenaSource(v.kind, v.seed + 7919) : puckSource(v.kind, v.seed, 1)
  const ca: number[] = []
  const cb: number[] = []
  for (let f = 0; f < frames; f++) {
    ca.push(a.next(f))
    cb.push(b.next(f))
  }
  return [ca, cb]
}

/** Replays one log through the real sim and returns the final hash, the trace and some coverage numbers. */
export function runNetVector(v: NetVector): NetResult {
  const hashes: string[] = []
  const a = v.game === 'fighter' ? fighterSource(v.kind, v.seed) : v.game === 'arena' ? arenaSource(v.kind, v.seed) : puckSource(v.kind, v.seed, 0)
  const b = v.game === 'fighter' ? fighterSource(v.kind, v.seed + 7919) : v.game === 'arena' ? arenaSource(v.kind, v.seed + 7919) : puckSource(v.kind, v.seed, 1)
  let frames = 0
  let activity = 0
  if (v.game === 'fighter') {
    const s = fighterCreate(v.seed)
    for (let f = 0; f < v.frames && s.matchOver === 0; f++) {
      fighterStep(s, a.next(f), b.next(f))
      frames++
      if (s.fighters[0].events !== 0 || s.fighters[1].events !== 0) activity++
      if (frames % TRACE_EVERY === 0) hashes.push(hashFighterState(s))
    }
    hashes.push(hashFighterState(s))
    return { frames, hash: hashFighterState(s), trace: traceOf(hashes), activity, extremes: 0 }
  }
  if (v.game === 'arena') {
    const s = arenaCreate(v.seed)
    for (let f = 0; f < v.frames && s.matchOver === 0; f++) {
      arenaStep(s, a.next(f), b.next(f))
      frames++
      if (s.players[0].events !== 0 || s.players[1].events !== 0) activity++
      if (frames % TRACE_EVERY === 0) hashes.push(hashArenaState(s))
    }
    hashes.push(hashArenaState(s))
    return { frames, hash: hashArenaState(s), trace: traceOf(hashes), activity, extremes: a.extremes + b.extremes }
  }
  const s = puckCreate(v.seed, { limits: [null, null] })
  for (let f = 0; f < v.frames && s.matchOver === 0; f++) {
    puckStep(s, [a.next(f), b.next(f)])
    frames++
    // Events (goals, shots, saves) and frames with the puck near its top speed.
    if (s.ev !== 0 || s.pvx * s.pvx + s.pvy * s.pvy > 0.64 * PUCK_MAX_SPEED * PUCK_MAX_SPEED) activity++
    if (frames % TRACE_EVERY === 0) hashes.push(hashPuckState(s))
  }
  hashes.push(hashPuckState(s))
  return { frames, hash: hashPuckState(s), trace: traceOf(hashes), activity, extremes: a.extremes + b.extremes }
}

/**
 * Pinned results from the Bun run (the Bun test checks them; the browser page /dev/determinism checks them in Chromium and WebKit).
 * `minActivity` is a floor under the coverage count, so a log that stopped doing anything would fail loudly. Change a hash only with a
 * reason: a sim change (new hash everywhere) or a fixed sim.
 */
export const NET_VECTOR_HASHES: Record<string, { frames: number; hash: string; trace: string; minActivity: number }> = {
  'fighter-mash': { frames: 3000, hash: '81ce5bdf41e151b3', trace: 'b7fcfc18a4bb8980', minActivity: 100 },
  'fighter-hold': { frames: 9000, hash: 'aea254dea4fc8412', trace: 'd10e0179f9dd8326', minActivity: 200 },
  'fighter-long': { frames: 11492, hash: 'dfc5ded3075137f5', trace: '447134a1294d8936', minActivity: 250 },
  'arena-spin': { frames: 3000, hash: '48a55b739090086b', trace: '8c4172d705cf297b', minActivity: 60 },
  'arena-strafe': { frames: 9000, hash: '487e505508ac443c', trace: '8a45a738c2ef1428', minActivity: 120 },
  'arena-mixed': { frames: 20000, hash: '60b0dc3ac1ab7dc1', trace: 'cf72ab69964daf72', minActivity: 400 },
  'puck-sweep': { frames: 3000, hash: '4156e2bce832ec1d', trace: 'caac723d7ce4d16f', minActivity: 200 },
  'puck-corners': { frames: 3469, hash: 'ab850d7c2927ac18', trace: 'bd5731455efdf954', minActivity: 500 },
  'puck-fast': { frames: 3122, hash: '7efc009849b8733c', trace: 'a301606827f35d67', minActivity: 400 },
}

export interface NetMismatch {
  id: string
  field: 'frames' | 'hash' | 'trace' | 'activity'
  want: unknown
  got: unknown
}

/** Runs every vector and lists what differs from the pinned results. Empty means this engine agrees with Bun. */
export function checkNetVectors(): { results: Record<string, NetResult>; bad: NetMismatch[] } {
  const results: Record<string, NetResult> = {}
  const bad: NetMismatch[] = []
  for (const v of NET_VECTORS) {
    const r = runNetVector(v)
    results[v.id] = r
    const want = NET_VECTOR_HASHES[v.id]!
    for (const f of ['frames', 'hash', 'trace'] as const) if (r[f] !== want[f]) bad.push({ id: v.id, field: f, want: want[f], got: r[f] })
    if (r.activity <= want.minActivity) bad.push({ id: v.id, field: 'activity', want: `> ${want.minActivity}`, got: r.activity })
  }
  return { results, bad }
}
