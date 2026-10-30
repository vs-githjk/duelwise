import registry from '../../registry/arena.json'
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ACTION_NVEC_V2, KEEP_MOVE } from '@duelwise/core/src/games/arena/actions'
import { createState, stepPacked } from '@duelwise/core/src/games/arena/core'
import { createEnv as createArenaEnv, OBS_FEATURES as ENV_OBS_FEATURES } from '@duelwise/core/src/games/arena/env'
import { unpackInput } from '@duelwise/core/src/games/arena/input'
import { PHASE, type ArenaState } from '@duelwise/core/src/games/arena/state'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { nextSeed } from '@duelwise/core/src/bridge/env-host'
import { makeRng } from '@duelwise/core/src/rng'
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent, PRACTICE_MODELS, PUBLISHED_V1, type ArenaReply } from './agent'
import { ArenaSeatInput, BUY_DECISIONS, FRAME_SKIP, OBS_FEATURES, seatView, V2_FEATURES, viewDue } from './view'

/** Exported from the b2 gated Hard snapshot (step 14,024,704) with training/trainer/ppo/export.py: 90 inputs, a move head of 10. */
const V2_MODEL = join(import.meta.dir, '../../test-fixtures/arena-v2-hard-b2.onnx')

/** Runs the agent as the page does: a call on every frame that needs a view or a decision. */
async function drive(level: Level, seed: number, frames: number, modelBytes?: Uint8Array) {
  const agent = await createGameAgent(level, { seat: 1, modelBytes })
  agent.reset(seed)
  const s: ArenaState = createState(seed)
  const delay = LEVEL_LIMITS.arena[level].delayFrames
  let anchor = s.frame
  let phase: number = s.phase
  let queue: number[] = []
  let rest = 0
  const decisions: Array<{ frame: number; first: number; rest: number }> = []
  let spentOutsideBuy = false
  for (let i = 0; i < frames && s.matchOver === 0; i++) {
    if (s.phase !== phase) {
      phase = s.phase
      anchor = s.frame
    }
    const due = viewDue(s.frame, anchor, delay, s.phase)
    if (due.capture || due.decide) {
      const r = (await agent.act(seatView(s, 1), { frame: s.frame, anchor, phase: s.phase, weapon: s.players[1].weapon })) as ArenaReply
      if (r[2] === 1) {
        decisions.push({ frame: s.frame, first: r[0], rest: r[1] })
        queue = [r[0]]
        rest = r[1]
      } else expect(r[0]).toBe(r[1])
    }
    const before = s.phase === PHASE.BUY ? -1 : s.players[1].money
    stepPacked(s, 0, s.phase === PHASE.ROUND_END ? 0 : (queue.shift() ?? rest))
    if (before >= 0 && s.players[1].money < before) spentOutsideBuy = true
  }
  agent.dispose()
  return { decisions, state: s, spentOutsideBuy }
}

describe('arena view schedule', () => {
  test('live: a decision every 4th frame from the anchor; buy: two decisions; round end: none', () => {
    const live: number[] = []
    const buy: number[] = []
    for (let f = 100; f < 160; f++) {
      if (viewDue(f, 100, 12, PHASE.LIVE).decide) live.push(f)
      if (viewDue(f, 100, 12, PHASE.BUY).decide) buy.push(f)
      expect(viewDue(f, 100, 12, PHASE.ROUND_END)).toEqual({ capture: false, decide: false })
    }
    expect(live).toEqual(Array.from({ length: 15 }, (_, i) => 100 + 4 * i))
    expect(buy).toEqual([100, 104])
    expect(buy.length).toBe(BUY_DECISIONS)
  })

  test('records the anchor frame and every frame `delay` before a decision', () => {
    for (const delay of [3, 12, 15, 18]) {
      for (let f = 100; f < 140; f++) {
        const d = viewDue(f, 100, delay, PHASE.LIVE)
        if (f === 100) expect(d.capture).toBe(true)
        else expect(d.capture).toBe((f - 100 + delay) % FRAME_SKIP === 0)
      }
    }
  })

  test('seatView has the width the models were trained on', () => {
    expect(seatView(createState(1), 1).length).toBe(OBS_FEATURES)
  })
})

describe('arena agent', () => {
  test('a level is a preview unless the registry publishes it (Easy now)', async () => {
    const bytes = new Uint8Array(await Bun.file(V2_MODEL).arrayBuffer())
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
      const agent = await createGameAgent(level, { modelBytes: bytes })
      expect(agent.preview).toBe(!PUBLISHED_V1.includes(level))
      agent.dispose()
    }
    expect(PUBLISHED_V1).toEqual((Object.keys(registry.levels) as Level[]))
    expect((await createGameAgent('easy', { modelBytes: bytes })).preview).toBe(!(Object.keys(registry.levels) as Level[]).includes('easy'))
    expect((await createGameAgent('medium', { modelBytes: bytes })).preview).toBe(true)
    expect((await createGameAgent('hard', { modelBytes: bytes })).preview).toBe(true)
    expect((await createGameAgent('champion', { modelBytes: bytes })).preview).toBe(false)
  })

  test('every level loads a b4 or b3 network: no level is served the old preview net, every file exists, and only the unpublished Medium and Hard are Practice', async () => {
    const root = join(import.meta.dir, '../../../../apps/web/public')
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
      const path = PRACTICE_MODELS[level]
      expect(path, level).not.toContain('preview')
      expect(await Bun.file(join(root, path)).exists(), path).toBe(true)
    }
    // Published levels (KC3) load their own v1 file; Medium runs the Easy network under its own limits, Hard (held) the b3 checkpoint.
    expect(PRACTICE_MODELS.easy).toBe('agents/arena/v1/easy.onnx')
    expect(PRACTICE_MODELS.medium).toBe('agents/arena/v1/easy.onnx')
    expect(PRACTICE_MODELS.hard).toBe('agents/arena/practice/hard-b3.onnx')
    expect(PRACTICE_MODELS.champion).toBe('agents/arena/v1/champion.onnx')
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
      const agent = await createGameAgent(level, { seat: 1 })
      expect(agent.preview, level).toBe(!(Object.keys(registry.levels) as Level[]).includes(level))
      agent.dispose()
    }
  })

  test('answers a legal packed input on every decision, deterministically for a seed', async () => {
    const a = await drive('champion', 5, 1500)
    const b = await drive('champion', 5, 1500)
    // The mirrored seat 1 observation (KC2) makes the network win quickly against a seat that stands still, so the match ends early (the b4 Champion in 37 decisions).
    expect(a.decisions.length).toBeGreaterThan(20)
    for (const d of a.decisions) {
      const first = unpackInput(d.first)
      expect(first.move).toBeLessThan(9)
      expect(unpackInput(d.rest).buy).toBe(0)
    }
    expect(b.decisions).toEqual(a.decisions)
    expect(b.state.frame).toBe(a.state.frame)
  })

  test('spends money only in the buy phase and only what it can afford', async () => {
    // A trained policy also emits buy choices in the live phase (as in training); the sim ignores them, so what counts is what was spent.
    const { decisions, state, spentOutsideBuy } = await drive('hard', 11, 700, new Uint8Array(await Bun.file(V2_MODEL).arrayBuffer()))
    expect(decisions.some((d) => unpackInput(d.first).buy !== 0)).toBe(true)
    expect(spentOutsideBuy).toBe(false)
    expect(state.players[1].money).toBeGreaterThanOrEqual(0)
  })

  test('applies the level aim limit: at Easy no turn exceeds the rate cap plus its noise', async () => {
    const lim = LEVEL_LIMITS.arena.easy
    const cap = Math.floor(((lim.aimRateDegPerSec ?? 0) / 60) * (8192 / 360))
    const noise = Math.ceil(((lim.aimNoiseDeg ?? 0) * 8192) / 360) + 1
    const { decisions } = await drive('easy', 3, 1500)
    for (const d of decisions) expect(Math.abs(unpackInput(d.first).yaw)).toBeLessThanOrEqual(cap + noise)
  })

  test('a semi-automatic trigger is released after the first frame of a decision', async () => {
    const { decisions } = await drive('champion', 8, 1500)
    const shots = decisions.filter((d) => unpackInput(d.first).fire === 1)
    expect(shots.length).toBeGreaterThan(0)
    // Champion starts on the Dart pistol (semi-automatic): every later frame of such a decision is released.
    for (const d of shots.filter((x) => x.rest !== x.first)) expect(unpackInput(d.rest).fire).toBe(0)
  })

  test('refuses a view of the wrong width', async () => {
    const agent = await createGameAgent('hard', { seat: 1 })
    agent.reset(1)
    await expect(agent.act(new Float32Array(3), { frame: 0, anchor: 0, phase: PHASE.BUY, weapon: 0 })).rejects.toThrow()
    agent.dispose()
  })
})

describe('arena observation v2 (T8c)', () => {
  test('the runtime constants equal the env constants', () => {
    expect(V2_FEATURES).toBe(ENV_OBS_FEATURES)
    expect(V2_FEATURES).toBe(90)
    expect(ACTION_NVEC_V2[0]).toBe(KEEP_MOVE + 1)
  })

  /**
   * Plays the training env and, beside it, the runtime path (view schedule, seat input pipeline, live sim) with
   * the same seed and the same raw action heads, and compares both seats' observations at every decision.
   * Heads include KEEP_MOVE, so the held-input extras, the free hold, the trigger slots and the aim limits agree.
   */
  for (const level of ['easy', 'hard', 'champion'] as const) {
    test(`runtime observation equals the env observation over 2,000 frames (${level})`, () => {
      const cfg = LEVEL_LIMITS.arena[level]
      const env = createArenaEnv!({ n: 1, seed: 0, level })
      let seed = 23
      let obs = env.reset([seed])
      const pick = makeRng(11)
      const seats = [new ArenaSeatInput(cfg, 0), new ArenaSeatInput(cfg, 1)]
      let sim: ArenaState
      let anchor = 0
      let phase = 0
      // Records the live views the limiters will read later, and re-anchors when the phase changed.
      const sync = () => {
        if (sim.phase !== phase) {
          phase = sim.phase
          anchor = sim.frame
          for (const k of [0, 1]) seats[k]!.startPhase()
          if (phase !== PHASE.ROUND_END) for (const k of [0, 1] as const) seats[k]!.record(seatView(sim, k), sim.frame)
          return
        }
        if (viewDue(sim.frame, anchor, cfg.delayFrames, sim.phase).capture) for (const k of [0, 1] as const) seats[k]!.record(seatView(sim, k), sim.frame)
      }
      // Per seat: the packed inputs for the frames of the current decision, then neutral.
      let plan: Array<[number, number]> = [[0, 0], [0, 0]]
      let left = 0
      const stepOne = () => {
        const first = left === 4
        const p = plan.map((x) => (left > 0 ? (first ? x[0] : x[1]) : 0))
        if (left > 0) left--
        stepPacked(sim, p[0]!, p[1]!)
        sync()
      }
      const advance = () => {
        while (sim.matchOver === 0 && !viewDue(sim.frame, anchor, cfg.delayFrames, sim.phase).decide) stepOne()
      }
      const begin = () => {
        sim = createState(seed)
        for (const k of [0, 1]) seats[k]!.reset(seed)
        phase = sim.phase
        anchor = sim.frame
        plan = [[0, 0], [0, 0]]
        left = 0
        for (const k of [0, 1] as const) seats[k]!.record(seatView(sim, k), sim.frame)
        advance()
      }
      begin()
      let frames = 0
      let decisions = 0
      let keeps = 0
      while (frames < 2000) {
        const mine = new Float32Array(V2_FEATURES)
        for (const k of [0, 1] as const) {
          seats[k]!.observe(sim!.frame, mine, true)
          expect(Array.from(mine)).toEqual(Array.from(obs.subarray(k * V2_FEATURES, (k + 1) * V2_FEATURES)))
        }
        const actions = new Int32Array(18)
        for (let k = 0; k < 2; k++) {
          for (let d = 0; d < ACTION_NVEC_V2.length; d++) actions[k * 9 + d] = Math.floor(pick.float() * ACTION_NVEC_V2[d]!)
          if (pick.float() < 0.4) actions[k * 9] = KEEP_MOVE
          if (actions[k * 9] === KEEP_MOVE) keeps++
          plan[k] = seats[k]!.decide(actions.subarray(k * 9, k * 9 + 9), sim!.frame, sim!.phase, sim!.players[k]!.weapon)
        }
        left = 4
        const res = env.step(actions)
        obs = res.obs
        decisions++
        for (let f = 0; f < 4 && sim!.matchOver === 0; f++) stepOne()
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

  test('a v2 model exported from a b2 gated snapshot loads and plays a full match', async () => {
    const bytes = new Uint8Array(await Bun.file(V2_MODEL).arrayBuffer())
    const realDecide = ArenaSeatInput.prototype.decide
    let keepMoves = 0
    ArenaSeatInput.prototype.decide = function (this: ArenaSeatInput, heads: Int32Array, frame: number, phase: number, weapon: number) {
      if (heads[0] === KEEP_MOVE) keepMoves++
      return realDecide.call(this, heads, frame, phase, weapon)
    }
    let result: Awaited<ReturnType<typeof drive>>
    try {
      result = await drive('hard', 4, 60 * 60 * 6, bytes)
      // The agent now wins quickly against a seat that stands still (KC2), so one match may be too short to show a keep: add seeds until one does.
      for (let seed = 5; keepMoves === 0 && seed < 12; seed++) await drive('hard', seed, 60 * 60 * 6, bytes)
    } finally {
      ArenaSeatInput.prototype.decide = realDecide
    }
    const { decisions, state } = result
    expect(keepMoves).toBeGreaterThan(0)
    expect(state.matchOver).toBe(1)
    expect(decisions.length).toBeGreaterThan(100)
    for (const d of decisions) expect(unpackInput(d.first).move).toBeLessThan(9)
  })

  test('refuses a model whose input width is neither v1 nor v2', async () => {
    const bad = new Uint8Array(await Bun.file(join(import.meta.dir, '../../test-fixtures/fighter-v2-hard-b2.onnx')).arrayBuffer())
    await expect(createGameAgent('hard', { seat: 1, modelBytes: bad })).rejects.toThrow(/features/)
  })
})
