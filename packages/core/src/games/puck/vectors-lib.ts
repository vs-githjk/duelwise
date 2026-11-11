import { makeRng } from '../../rng'
import { hashState } from '../../hash'
import type { Level } from '../../product'
import { GRID, HARD_CAP_FRAMES, LEVEL_MALLET, MALLET_R, NO_INPUT } from './constants'
import { observe, stepState } from './core'
import { createState, hashPuckState, type PuckState } from './state'

// Cross-engine determinism vectors. One definition of the matches, used by the generator (scripts/puck-vectors.ts),
// the Bun test, the Node check and the dev page (apps/web/src/dev-views/puck-vectors.tsx), so every engine replays the same thing.
// Everything here obeys the sim's determinism rule: + - * / sqrt abs min max floor round only, randomness from makeRng.

export const POLICIES = ['random', 'hold', 'idle', 'rush', 'striker', 'goalie', 'banker', 'shadow', 'edge'] as const
export type Policy = (typeof POLICIES)[number]
export const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']

export interface VectorSpec {
  id: number
  seed: number
  a: Policy
  b: Policy
  /** Mallet limits per seat: a level name, or null for the rule defaults (the human finger). */
  limA: Level | null
  limB: Level | null
  frames: number
}

export interface VectorExpect {
  /** Frames actually stepped (the match can end before spec.frames). */
  frames: number
  /** Hash of the final state. */
  hash: string
  /** Hash of the state hashes taken every CHECK_EVERY frames, so a mid-match divergence cannot hide behind a re-converged end. */
  trace: string
  score: [number, number]
  winner: number
}

export interface VectorFile {
  version: 'puck-2'
  generator: string
  count: number
  vectors: Array<VectorSpec & { expect: VectorExpect }>
}

export const CHECK_EVERY = 250
export const VECTOR_COUNT = 300

const cell = (u: number): number => {
  const c = Math.round(u * (GRID - 1))
  return c < 0 ? 0 : c > GRID - 1 ? GRID - 1 : c
}
const code = (ux: number, uy: number): number => cell(ux) + GRID * cell(uy)

/** Per-seat scripted input source. Reads the live state through the seat's own view (floats, so engine drift would show). */
interface Source { next(s: PuckState, seat: 0 | 1): number }

function makeSource(policy: Policy, seed: number): Source {
  const rng = makeRng(seed)
  let held = code(0.5, 0.3)
  return {
    next(s, seat) {
      const o = observe(s, seat)
      const [px, py, pvx, pvy] = o.puck
      const me = o.me
      const them = o.them
      switch (policy) {
        case 'random':
          if (rng.int(8) === 0) held = code(rng.float(), rng.float())
          return held
        case 'hold':
          // A new target only now and then: long runs of the mallet chasing a stale point.
          if (rng.int(90) === 0) held = code(rng.float(), rng.float())
          return held
        case 'idle':
          return NO_INPUT
        case 'rush':
          // Straight at the puck every frame, clamped into the own half by the sim: the top-speed hit fuzz.
          return code(px, py < 1 ? py : 1)
        case 'striker': {
          if (py < 1 + MALLET_R && py >= 0) {
            // Line up behind the puck then drive through it toward the goal.
            const behind = py - 0.12
            const dx = px - me[0]
            const near = dx < 0.1 && dx > -0.1 && me[1] < py
            return near ? code(px, py + 0.15) : code(px, behind < 0.02 ? 0.02 : behind)
          }
          return code(0.5, 0.25)
        }
        case 'goalie': {
          // Hold the line, slide with the puck, step out when it is slow and close.
          const x = px < 0.3 ? 0.3 : px > 0.7 ? 0.7 : px
          const slow = pvx * pvx + pvy * pvy < 0.5
          return py < 0.55 && slow ? code(px, py) : code(x, 0.1)
        }
        case 'banker': {
          // Aim at the puck's mirror image across the nearer side wall, a crude bank shot.
          const wall = px < 0.5 ? 0 : 1
          const ax = wall === 0 ? px - 0.08 : px + 0.08
          return py < 1 ? code(ax, py - 0.1 < 0 ? 0 : py - 0.1) : code(0.5, 0.35)
        }
        case 'shadow':
          // Mirror the other mallet's lateral position at a fixed depth.
          return code(1 - them[0], 0.2 + 0.4 * (them[1] - 1 < 0 ? 0 : them[1] - 1 > 1 ? 1 : them[1] - 1))
        case 'edge': {
          // Cling to the walls and corners (squeeze territory): follow the puck's side, at the end line.
          const side = px < 0.5 ? 0.02 : 0.98
          return rng.int(40) === 0 ? code(rng.float(), rng.float()) : code(side, py < 1 ? py : 0.05)
        }
      }
    },
  }
}

/** The 300 matches. A pure function of its constants, so the generator and every checker agree on what a vector is. */
export function vectorSpecs(): VectorSpec[] {
  const rng = makeRng(20261110)
  const out: VectorSpec[] = []
  for (let id = 0; id < VECTOR_COUNT; id++) {
    const seed = (rng.int(4294967296) >>> 0) || 1
    let a: Policy
    let b: Policy
    let frames = 2400 + 600 * rng.int(8)
    if (id < 9) {
      // Same policy on both seats, one of each: every behaviour meets itself.
      a = POLICIES[id]!
      b = POLICIES[id]!
    } else if (id < 36) {
      // Top-speed fuzz: both mallets rush the puck every frame at the rule cap.
      a = 'rush'
      b = id % 3 === 0 ? 'rush' : id % 3 === 1 ? 'striker' : 'edge'
    } else {
      a = POLICIES[rng.int(POLICIES.length)]!
      b = POLICIES[rng.int(POLICIES.length)]!
    }
    // The long ones run into the cap and sudden death paths: idle pairs hit the stall rules, 36,000 reaches the hard cap.
    if (id >= 290 && id < 296) { a = 'idle'; b = id % 2 === 0 ? 'idle' : 'hold'; frames = HARD_CAP_FRAMES }
    if (id >= 296) { a = POLICIES[rng.int(POLICIES.length)]!; b = POLICIES[rng.int(POLICIES.length)]!; frames = 22_000 }
    const limA = id < 36 || rng.int(3) === 0 ? null : LEVELS[rng.int(4)]!
    const limB = id < 36 || rng.int(3) === 0 ? null : LEVELS[rng.int(4)]!
    out.push({ id, seed, a, b, limA, limB, frames })
  }
  return out
}

/** Play one vector from scratch and return what the engines must agree on. */
export function runVector(spec: VectorSpec): VectorExpect {
  const s = createState(spec.seed, {
    limits: [spec.limA ? LEVEL_MALLET[spec.limA] : null, spec.limB ? LEVEL_MALLET[spec.limB] : null],
  })
  const srcA = makeSource(spec.a, spec.seed ^ 0x9e3779b9)
  const srcB = makeSource(spec.b, spec.seed ^ 0x7f4a7c15)
  const inputs: [number, number] = [NO_INPUT, NO_INPUT]
  const marks: string[] = []
  let frames = 0
  while (frames < spec.frames && s.matchOver !== 1) {
    inputs[0] = srcA.next(s, 0)
    inputs[1] = srcB.next(s, 1)
    stepState(s, inputs)
    frames++
    if (frames % CHECK_EVERY === 0) marks.push(hashPuckState(s))
  }
  return {
    frames,
    hash: hashPuckState(s),
    trace: hashState(marks),
    score: [s.score[0], s.score[1]],
    winner: s.winner,
  }
}

export function buildFile(): VectorFile {
  const vectors = vectorSpecs().map((v) => ({ ...v, expect: runVector(v) }))
  return { version: 'puck-2', generator: 'bun scripts/puck-vectors.ts --write', count: vectors.length, vectors }
}

export interface Mismatch { id: number; field: string; want: unknown; got: unknown }

/** Replay every vector in the file; returns the list of mismatches (empty when this engine agrees). */
export function checkFile(file: VectorFile): Mismatch[] {
  const bad: Mismatch[] = []
  for (const v of file.vectors) {
    const got = runVector(v)
    for (const f of ['frames', 'hash', 'trace', 'winner'] as const) {
      if (got[f] !== v.expect[f]) bad.push({ id: v.id, field: f, want: v.expect[f], got: got[f] })
    }
    if (got.score[0] !== v.expect.score[0] || got.score[1] !== v.expect.score[1]) bad.push({ id: v.id, field: 'score', want: v.expect.score, got: got.score })
  }
  return bad
}
