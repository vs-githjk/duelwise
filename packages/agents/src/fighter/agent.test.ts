import { describe, expect, test } from 'bun:test'
import registry from '../../registry/fighter.json'
import { join } from 'node:path'
import { createEnv as createFighterEnv, KEEP_BUTTON as ENV_KEEP_BUTTON, OBS_FEATURES as ENV_OBS_FEATURES } from '@duelwise/core/src/games/fighter/env'
import { createState, PHASE, type FighterState } from '@duelwise/core/src/games/fighter/state'
import { makeRng } from '@duelwise/core/src/rng'
import type { Level } from '@duelwise/core/src/product'
import { nextSeed } from '@duelwise/core/src/bridge/env-host'
import { stepPacked } from '@duelwise/core/src/games/fighter/core'
import { packInput } from '@duelwise/core/src/games/fighter/input'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { createGameAgent, PUBLISHED_V1 } from './agent'
import { agentInputLagFor } from '@duelwise/core/src/games/fighter/constants'
import { BUTTON_HEAD, FighterSeatInput, InputLag, KEEP_BUTTON, OBS_FEATURES, seatView, V2_FEATURES, viewDue } from './view'

const MODELS = join(import.meta.dir, '../../../../apps/web/public/agents/fighter/preview')
const load = async (name: string) => new Uint8Array(await Bun.file(join(MODELS, `${name}.onnx`)).arrayBuffer())
/** Exported from the b2 gated Hard snapshot (step 30,015,488) with training/trainer/ppo/export.py: 162 inputs, a button head of 8. */
const V2_MODEL = join(import.meta.dir, '../../test-fixtures/fighter-v2-hard-b2.onnx')

/** Runs the agent as the page does: a call on every frame that needs a view or a decision. */
async function drive(level: 'easy' | 'hard' | 'champion', seed: number, frames: number) {
  const agent = await createGameAgent(level, { seat: 1, modelBytes: await load(level === 'easy' ? 'medium' : level) } as never)
  agent.reset(seed)
  const s: FighterState = createState(seed)
  const delay = LEVEL_LIMITS.fighter[level].delayFrames
  let anchor = -1
  let held: number[] = [0, 0]
  const chosen: number[][] = []
  for (let i = 0; i < frames; i++) {
    if (s.phase === PHASE.FIGHT && anchor < 0) anchor = s.frame
    if (s.phase === PHASE.FIGHT) {
      const due = viewDue(s.frame, anchor, delay)
      if (due.capture || due.decide) {
        held = await agent.act(seatView(s, 1), { frame: s.frame, anchor })
        if (due.decide) chosen.push(held)
      }
    }
    stepPacked(s, 0, s.phase === PHASE.FIGHT ? packInput({ dir: held[0]!, btn: held[1]! }) : 0)
  }
  agent.dispose()
  return { chosen, state: s }
}

describe('fighter view schedule', () => {
  test('decides every 4th frame from the anchor and records the view `delay` frames before each decision', () => {
    for (const delay of [3, 12, 15, 18]) {
      const decisions: number[] = []
      const captures: number[] = []
      for (let f = 100; f < 140; f++) {
        const d = viewDue(f, 100, delay)
        if (d.decide) decisions.push(f)
        if (d.capture) captures.push(f)
      }
      expect(decisions).toEqual([100, 104, 108, 112, 116, 120, 124, 128, 132, 136])
      // The anchor frame is always recorded (the env does the same), then frames congruent to -delay mod 4.
      expect(captures.includes(100)).toBe(true)
      for (const f of captures.filter((x) => x !== 100)) expect((f - 100 + delay) % 4).toBe(0)
    }
  })
})

describe('fighter agent', () => {
  test('seatView has the width the models were trained on', () => {
    expect(seatView(createState(1), 1).length).toBe(OBS_FEATURES)
    expect(OBS_FEATURES).toBe(143)
  })

  test('returns a legal [dir, button] on every decision and the same seed gives the same inputs', async () => {
    const a = await drive('champion', 5, 400)
    const b = await drive('champion', 5, 400)
    expect(a.chosen.length).toBeGreaterThan(50)
    for (const [d, btn] of a.chosen) {
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(9)
      expect(btn).toBeGreaterThanOrEqual(0)
      expect(btn).toBeLessThan(7)
    }
    expect(b.chosen).toEqual(a.chosen)
    expect(b.state.frame).toBe(a.state.frame)
  })

  test('applies the level limits: at Easy a held input changes at most once per minHold frames', async () => {
    const { chosen } = await drive('easy', 9, 1500)
    const hold = LEVEL_LIMITS.fighter.easy.minHoldFrames
    let lastChange = -1e9
    let held = [0, 0]
    let i = 0
    for (const c of chosen) {
      const frame = i * 4
      i++
      if (c[0] !== held[0] || c[1] !== held[1]) {
        expect(frame - lastChange).toBeGreaterThanOrEqual(hold)
        lastChange = frame
        held = c
      }
    }
  })

  test('loads its own weights from the repo when no bytes are passed (the path the harness uses)', async () => {
    const agent = await createGameAgent('hard', { seat: 1 })
    agent.reset(1)
    const s = createState(1)
    for (let i = 0; i < 40; i++) stepPacked(s, 0, 0)
    const out = await agent.act(seatView(s, 1), { frame: s.frame, anchor: s.frame })
    expect(out.length).toBe(2)
    agent.dispose()
  })

  test('a short run of 3000 frames never throws and ends the clock in a legal state', async () => {
    const { state } = await drive('hard', 3, 3000)
    expect(state.frame).toBeGreaterThanOrEqual(3000)
  })
})

describe('fighter agent preview flag', () => {
  test('a published level is not a preview; a level in training is', async () => {
    expect(PUBLISHED_V1).toEqual(Object.keys(registry.levels) as Level[])
    const bytes = new Uint8Array(await Bun.file(V2_MODEL).arrayBuffer())
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
      const agent = await createGameAgent(level, { seat: 1, modelBytes: bytes } as never)
      expect(agent.preview).toBe(!PUBLISHED_V1.includes(level))
      agent.dispose()
    }

  })
})

describe('fighter observation v2 (T8c)', () => {
  test('the runtime constants equal the env constants', () => {
    expect(V2_FEATURES).toBe(ENV_OBS_FEATURES)
    expect(V2_FEATURES).toBe(162)
    expect(KEEP_BUTTON).toBe(ENV_KEEP_BUTTON)
    expect(BUTTON_HEAD).toBe(8)
  })

  /**
   * Plays the training env and, beside it, the runtime path (view schedule, seat input pipeline, live sim) with
   * the same seed and the same raw actions, and compares both seats' observations at every decision. Actions
   * include KEEP_BUTTON, so the held-input extras, the free hold and the APM window all have to agree.
   */
  for (const level of ['easy', 'hard', 'champion'] as const) {
    test(`runtime observation equals the env observation over 2,000 frames (${level})`, async () => {
      const cfg = LEVEL_LIMITS.fighter[level]
      const env = createFighterEnv!({ n: 1, seed: 0, level })
      let seed = 41
      let obs = env.reset([seed])
      const pick = makeRng(7)
      const seats = [new FighterSeatInput(cfg, 0), new FighterSeatInput(cfg, 1)]
      let sim!: FighterState
      let anchor = -1
      let inputs = [new InputLag(), new InputLag()]
      // Starts (or restarts, after a match) the runtime side and runs it to its first decision.
      const begin = () => {
        sim = createState(seed)
        for (const k of [0, 1]) seats[k]!.reset(seed)
        anchor = -1
        inputs = [new InputLag(), new InputLag()]
        advance()
      }
      // LC1: the env holds an agent's decision from the frame its lag for this seed says, and so does the runtime side here.
      const input = (k: number) => inputs[k]!.at(sim.frame)
      // Records the live view when the schedule says a later decision will read it (the env captures after every step).
      const capture = (first: boolean) => {
        const due = viewDue(sim.frame, anchor, cfg.delayFrames)
        if (due.capture || first) for (const k of [0, 1] as const) seats[k]!.record(seatView(sim, k), sim.frame)
      }
      const stepOne = (neutral: boolean) => {
        stepPacked(sim, neutral ? 0 : input(0), neutral ? 0 : input(1))
        if (anchor >= 0 && sim.phase === PHASE.FIGHT) capture(false)
      }
      // Steps the sim (neutral outside the fight phase) to the next decision frame.
      const advance = () => {
        for (;;) {
          if (sim.phase !== PHASE.FIGHT) {
            if (sim.matchOver === 1) return
            anchor = -1
            stepOne(true)
            continue
          }
          if (anchor < 0) {
            anchor = sim.frame
            for (const k of [0, 1]) seats[k]!.startRound()
            capture(true)
          }
          if (viewDue(sim.frame, anchor, cfg.delayFrames).decide) return
          stepOne(false)
        }
      }
      begin()
      let frames = 0
      let decisions = 0
      let keeps = 0
      while (frames < 2000) {
        const mine = new Float32Array(V2_FEATURES)
        for (const k of [0, 1] as const) {
          seats[k]!.observe(sim!.frame, mine, true)
          const theirs = obs.subarray(k * V2_FEATURES, (k + 1) * V2_FEATURES)
          expect(Array.from(mine)).toEqual(Array.from(theirs))
        }
        const actions = new Int32Array(4)
        for (let k = 0; k < 2; k++) {
          actions[k * 2] = Math.floor(pick.float() * 9)
          const r = pick.float()
          actions[k * 2 + 1] = r < 0.4 ? KEEP_BUTTON : Math.floor(pick.float() * 7)
          if (actions[k * 2 + 1] === KEEP_BUTTON) keeps++
          const chosen = seats[k]!.choose(actions[k * 2]!, actions[k * 2 + 1]!, sim!.frame)
          inputs[k]!.decide(sim!.frame, packInput({ dir: chosen[0]!, btn: chosen[1]! }), agentInputLagFor(seed))
        }
        const res = env.step(actions)
        obs = res.obs
        decisions++
        for (let f = 0; f < 4 && sim!.matchOver === 0; f++) stepOne(false)
        frames += 4
        if (res.done[0] === 1) {
          seed = nextSeed(seed, 1)
          begin()
        } else advance()
      }
      expect(decisions).toBeGreaterThan(400)
      expect(keeps).toBeGreaterThan(100)
    })
  }

  test('a v2 model exported from a b2 gated snapshot loads and plays full matches', async () => {
    const bytes = new Uint8Array(await Bun.file(V2_MODEL).arrayBuffer())
    const realChoose = FighterSeatInput.prototype.choose
    let keepChosen = 0
    FighterSeatInput.prototype.choose = function (this: FighterSeatInput, dir: number, btn: number, frame: number) {
      if (btn === KEEP_BUTTON) keepChosen++
      return realChoose.call(this, dir, btn, frame)
    }
    try {
    for (const seed of [1, 2]) {
      const agent = await createGameAgent('hard', { seat: 1, modelBytes: bytes } as never)
      agent.reset(seed)
      const s: FighterState = createState(seed)
      const delay = LEVEL_LIMITS.fighter.hard.delayFrames
      let anchor = -1
      let held: number[] = [0, 0]
      let decisions = 0
      let keepsSeen = 0
      let frames = 0
      while (s.matchOver === 0 && frames < 60 * 60 * 5) {
        if (s.phase === PHASE.FIGHT) {
          if (anchor < 0) anchor = s.frame
          const due = viewDue(s.frame, anchor, delay)
          if (due.capture || due.decide) {
            const prev = held
            held = await agent.act(seatView(s, 1), { frame: s.frame, anchor })
            if (due.decide) {
              decisions++
              expect(held[0]).toBeGreaterThanOrEqual(0)
              expect(held[0]).toBeLessThan(9)
              expect(held[1]).toBeGreaterThanOrEqual(0)
              expect(held[1]).toBeLessThan(7)
              if (held[0] === prev[0] && held[1] === prev[1]) keepsSeen++
            }
          }
        } else anchor = -1
        stepPacked(s, 0, s.phase === PHASE.FIGHT ? packInput({ dir: held[0]!, btn: held[1]! }) : 0)
        frames++
      }
      agent.dispose()
      expect(s.matchOver).toBe(1)
      expect(decisions).toBeGreaterThan(100)
      expect(keepsSeen).toBeGreaterThan(0)
    }
    expect(keepChosen).toBeGreaterThan(0)
    } finally {
      FighterSeatInput.prototype.choose = realChoose
    }
  })

  test('refuses a model whose input width is neither v1 nor v2', async () => {
    const bad = new Uint8Array(await Bun.file(join(import.meta.dir, '../../test-fixtures/arena-v2-hard-b2.onnx')).arrayBuffer())
    await expect(createGameAgent('hard', { seat: 1, modelBytes: bad } as never)).rejects.toThrow(/features/)
  })
})
