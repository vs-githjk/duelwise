import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { hashState } from '@duelwise/core/src/hash'
import { BIN_X, BIN_Y, binX, binY } from '@duelwise/core/src/games/puck/encode'
import { LEVEL_MALLET, NO_INPUT, PHASE } from '@duelwise/core/src/games/puck/constants'
import { createEnv, OBS_FEATURES, type PuckEnv } from '@duelwise/core/src/games/puck/env'
import { stepState } from '@duelwise/core/src/games/puck/core'
import { SeatHands, botDelayFor, botHistory } from '@duelwise/core/src/games/puck/seat-hands'
import { createState, type PuckState } from '@duelwise/core/src/games/puck/state'
import { observe } from '@duelwise/core/src/games/puck/core'
import { ALL_BOT_KINDS } from '@duelwise/core/src/games/puck/bots'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import type { Level } from '@duelwise/core/src/product'
import puckRegistry from '../../registry/puck.json'
import { buildPolicyOnnx } from '../../fixtures/make-policy'
import { OrtSession } from '../runtime/ort-session'
import { createGameAgent, isPublished, modelPath, PREVIEW_MODEL, type PuckDecisionTrace } from './agent'
import { liveObs, obsFromSeen, viewDue, VIEW_FEATURES } from './view'

// A Sable snapshot (snap-A-0050036736 of puck-league-a) exported with packages/agents/fixtures/puck-fixture.ts.
const FIXTURES = join(import.meta.dir, '../../test-fixtures')
const MODEL = join(FIXTURES, 'puck-preview.onnx')
const loadBytes = async (path: string) => new Uint8Array(await Bun.file(path).arrayBuffer())
const PARITY = (await Bun.file(join(FIXTURES, 'puck-parity.json')).json()) as { source: string; features: number; obs: number[][]; logits: [number[][], number[][]] }
const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']

interface Run {
  traces: PuckDecisionTrace[]
  codes: number[]
  state: PuckState
}

/** The page's loop: the agent seat is seat 1 with the level's mallet limits, seat 0 holds still. act() is called on every frame, as the page does. */
async function drive(level: Level, seed: number, frames: number, opts: { tweak?: (frame: number, obs: Float32Array) => void; seedAgent?: number; greedy?: boolean; model?: Uint8Array } = {}): Promise<Run> {
  const traces: PuckDecisionTrace[] = []
  const agent = await createGameAgent(level, { seat: 1, modelBytes: opts.model ?? (await loadBytes(MODEL)), greedy: opts.greedy ?? false, onDecision: (t) => traces.push(t) })
  agent.reset(opts.seedAgent ?? seed)
  const s = createState(seed, { limits: [null, LEVEL_MALLET[level]] })
  const codes: number[] = []
  let held = NO_INPUT
  for (let i = 0; i < frames && s.matchOver === 0; i++) {
    const obs = liveObs(s, 1)
    opts.tweak?.(s.frame, obs)
    const [code] = await agent.act(obs, { frame: s.frame })
    if (code !== NO_INPUT) held = code!
    codes.push(code!)
    stepState(s, [NO_INPUT, held])
  }
  agent.dispose()
  return { traces, codes, state: s }
}

describe('parity with the Python policy', () => {
  test('onnxruntime-web reproduces the torch logits on real env observations within the export tolerance', async () => {
    const session = await OrtSession.create(await loadBytes(MODEL))
    expect(PARITY.obs.length).toBeGreaterThanOrEqual(32)
    expect(session.inputWidth).toBe(OBS_FEATURES)
    let worst = 0
    for (let i = 0; i < PARITY.obs.length; i++) {
      const out = Object.values(await session.run(session.inputNames[0]!, Float32Array.from(PARITY.obs[i]!), [1, OBS_FEATURES]))
      for (const h of [0, 1] as const) {
        const want = PARITY.logits[h][i]!
        expect(out[h]!.length).toBe(want.length)
        for (let j = 0; j < want.length; j++) worst = Math.max(worst, Math.abs(out[h]![j]! - want[j]!))
      }
    }
    // PARITY_TOLERANCE in training/trainer/export_onnx.py.
    expect(worst).toBeLessThanOrEqual(1e-5)
    await session.dispose()
  })

  test('the agent feeds the model exactly the 23 features it records, and its bins are the argmax of that model\'s logits', async () => {
    const ort = await OrtSession.create(await loadBytes(MODEL))
    const traces: PuckDecisionTrace[] = []
    const agent = await createGameAgent('champion', { seat: 1, greedy: true, modelBytes: await loadBytes(MODEL), onDecision: (t) => traces.push(t) })
    agent.reset(1)
    for (let i = 0; i < PARITY.obs.length; i++) {
      agent.reset(1)
      await agent.act(Float32Array.from(PARITY.obs[i]!), { frame: 0 })
    }
    expect(traces.length).toBe(PARITY.obs.length)
    const argmax = (xs: Float32Array) => xs.indexOf(Math.max(...Array.from(xs)))
    for (let i = 0; i < traces.length; i++) {
      const t = traces[i]!
      // Frame 0 sees itself: the match view and the mallet block are the row, the limiter fills the last two.
      expect(Array.from(t.seen.subarray(0, OBS_FEATURES - 2))).toEqual(PARITY.obs[i]!.slice(0, OBS_FEATURES - 2).map(Math.fround))
      const heads = Object.values(await ort.run(ort.inputNames[0]!, t.seen, [1, OBS_FEATURES]))
      expect(t.bins).toEqual([argmax(heads[0]!), argmax(heads[1]!)])
    }
    agent.dispose()
    await ort.dispose()
  })
})

describe('the agent reads only the delayed view', () => {
  test('a change to the live view the delay has not reached leaves the model input unchanged; once it reaches, the view carries it', async () => {
    const level: Level = 'hard'
    const delay = LEVEL_LIMITS.puck[level].delayFrames
    const base = await drive(level, 21, 160, { greedy: true })
    // Perturb the whole live match view at one captured frame (and only there).
    const at = 82
    expect(viewDue(at, delay).capture).toBe(true)
    const nudged = await drive(level, 21, 160, {
      greedy: true,
      tweak: (frame, obs) => {
        if (frame === at) {
          obs[0] = 0.9; obs[1] = 0.8; obs[2] = -0.7; obs[3] = 0.6; obs[4] = -0.5; obs[5] = 0.4; obs[8] = 0.5; obs[9] = 0.7; obs[12] = 0.9
        }
      },
    })
    expect(base.traces.length).toBeGreaterThan(60)
    let before = 0
    let reached = 0
    for (let i = 0; i < base.traces.length; i++) {
      const a = base.traces[i]!
      const b = nudged.traces[i]!
      expect(b.frame).toBe(a.frame)
      if (a.frame - delay < at) {
        expect(Array.from(b.seen)).toEqual(Array.from(a.seen))
        expect(b.code).toBe(a.code)
        before++
      } else if (a.frame - delay >= at && !reached) {
        // The first decision the delayed view reaches `at`: only the match view differs, and it differs.
        expect(Array.from(b.seen.subarray(0, VIEW_FEATURES))).not.toEqual(Array.from(a.seen.subarray(0, VIEW_FEATURES)))
        expect(b.seen[0]).toBeCloseTo(0.9, 6)
        reached = a.frame
      }
    }
    expect(before).toBeGreaterThan(30)
    expect(reached).toBeGreaterThan(0)
  })

  test('the mallet block is read live (a hand feels itself) while the match view is not', async () => {
    const traces: PuckDecisionTrace[] = []
    const agent = await createGameAgent('hard', { seat: 1, greedy: true, modelBytes: await loadBytes(MODEL), onDecision: (t) => traces.push(t) })
    agent.reset(3)
    const s = createState(3)
    for (let f = 0; f < 40; f++) {
      const obs = liveObs(s, 1)
      if (f === 38) { obs[VIEW_FEATURES] = 0.123; obs[VIEW_FEATURES + 4] = -0.456 }
      await agent.act(obs, { frame: f })
      stepState(s, [NO_INPUT, NO_INPUT])
    }
    const t = traces[traces.length - 1]!
    expect(t.frame).toBe(38)
    expect(t.seen[VIEW_FEATURES]).toBeCloseTo(0.123, 6)
    expect(t.seen[VIEW_FEATURES + 4]).toBeCloseTo(-0.456, 6)
    agent.dispose()
  })
})

describe('C2: nothing eases off with the score', () => {
  /** A policy that is exactly blind to the score: the preview shape with the weights of features 8 and 9 (my goals, their goals) zeroed. */
  async function scoreBlindModel(): Promise<Uint8Array> {
    const hidden = 64
    const rnd = (n: number, k: number) => Float32Array.from({ length: n }, (_, i) => Math.fround(Math.sin(i * 12.9898 + k * 78.233) * 0.4))
    const w0 = rnd(OBS_FEATURES * hidden, 1)
    for (const f of [8, 9]) for (let o = 0; o < hidden; o++) w0[f * hidden + o] = 0
    return buildPolicyOnnx({
      obs: OBS_FEATURES, hidden, nvec: [BIN_X, BIN_Y],
      trunk0: { w: w0, b: rnd(hidden, 2) }, trunk1: { w: rnd(hidden * hidden, 3), b: rnd(hidden, 4) },
      actor: { w: rnd(hidden * (BIN_X + BIN_Y), 5), b: rnd(BIN_X + BIN_Y, 6) }, critic: { w: rnd(hidden, 7), b: rnd(1, 8) },
    })
  }

  test('the agent adds no score dependence: same position with different scores gives the same bins and the same codes, sampled with one seed', async () => {
    const model = await scoreBlindModel()
    const tweakScore = (mine: number, theirs: number) => (_f: number, obs: Float32Array) => {
      obs[8] = mine / 7
      obs[9] = theirs / 7
    }
    const a = await drive('champion', 5, 400, { model, tweak: tweakScore(0, 0) })
    const b = await drive('champion', 5, 400, { model, tweak: tweakScore(6, 2) })
    const c = await drive('champion', 5, 400, { model, tweak: tweakScore(1, 6) })
    expect(a.traces.length).toBeGreaterThan(100)
    expect(b.traces.map((t) => t.bins)).toEqual(a.traces.map((t) => t.bins))
    expect(c.traces.map((t) => t.code)).toEqual(a.traces.map((t) => t.code))
    // And the score really reached the model input (the test is not vacuous).
    expect(b.traces[b.traces.length - 1]!.seen[8]).toBeCloseTo(6 / 7, 6)
  })

  test('the agent hands the score to the model untouched', async () => {
    const run = await drive('hard', 9, 120, { greedy: true, tweak: (_f, obs) => { obs[8] = 4 / 7; obs[9] = 5 / 7 } })
    expect(run.traces[run.traces.length - 1]!.seen[8]).toBeCloseTo(4 / 7, 6)
    expect(run.traces[run.traces.length - 1]!.seen[9]).toBeCloseTo(5 / 7, 6)
  })
})

describe('seeded sampling', () => {
  test('the same seed gives the same actions; another agent seed gives others', async () => {
    const a = await drive('champion', 14, 300)
    const b = await drive('champion', 14, 300)
    expect(b.codes).toEqual(a.codes)
    const c = await drive('champion', 14, 300, { seedAgent: 15 })
    expect(c.codes).not.toEqual(a.codes)
    expect(a.traces.length).toBeGreaterThan(100)
  })

  test('a call repeated on the same frame does not decide twice', async () => {
    const agent = await createGameAgent('hard', { seat: 1, modelBytes: await loadBytes(MODEL) })
    agent.reset(2)
    const s = createState(2)
    const obs = liveObs(s, 1)
    const first = await agent.act(obs, { frame: 0 })
    const again = await agent.act(obs, { frame: 0 })
    expect(first[0]).not.toBe(NO_INPUT)
    expect(again).toEqual([NO_INPUT])
    agent.dispose()
  })
})

describe('the hands: caps hold', () => {
  for (const level of ['medium', 'hard', 'champion'] as Level[]) {
    test(`${level}: the mallet never beats the level's speed, and a new target waits out the hold`, async () => {
      const lim = LEVEL_MALLET[level]
      const hold = LEVEL_LIMITS.puck[level].minHoldFrames
      const traces: PuckDecisionTrace[] = []
      const agent = await createGameAgent(level, { seat: 1, modelBytes: await loadBytes(MODEL), onDecision: (t) => traces.push(t) })
      agent.reset(31)
      const s = createState(31, { limits: [null, lim] })
      let held = NO_INPUT
      let maxSpeed = 0
      const changes: number[] = []
      let prev = ''
      for (let i = 0; i < 1500 && s.matchOver === 0; i++) {
        const [code] = await agent.act(liveObs(s, 1), { frame: s.frame })
        if (code !== NO_INPUT) held = code!
        stepState(s, [NO_INPUT, held])
        const m = s.m[1]!
        maxSpeed = Math.max(maxSpeed, Math.hypot(m.vx, m.vy))
        const key = `${m.tx.toFixed(6)},${m.ty.toFixed(6)}`
        if (key !== prev) { changes.push(s.frame); prev = key }
      }
      agent.dispose()
      expect(traces.length).toBeGreaterThan(500)
      expect(maxSpeed).toBeLessThanOrEqual(lim.speed + 1e-6)
      for (let i = 1; i < changes.length; i++) expect(changes[i]! - changes[i - 1]!).toBeGreaterThanOrEqual(Math.min(hold, 2))
      // The agent proposed on most decisions, but the limiter refused the ones inside the hold: fewer accepted changes than decisions.
      if (hold > 2) expect(changes.length).toBeLessThan(traces.length)
    })
  }

  test('target noise is the level\'s: a fixed bin gives a spread of cells with that sd', async () => {
    const hands = new SeatHands(1, 1, 'easy')
    const cells: number[] = []
    for (let f = 0; f < 4000; f += 10) cells.push(hands.act(0.5, 0.5, f) % 1024)
    const mean = cells.reduce((a, b) => a + b, 0) / cells.length
    const sd = Math.sqrt(cells.reduce((a, b) => a + (b - mean) ** 2, 0) / cells.length) / 1023
    expect(sd).toBeGreaterThan(0.04)
    expect(sd).toBeLessThan(0.08)
  })
})

describe('routing', () => {
  test('Easy is the scripted Pip with no model; the others play the ONNX policy', async () => {
    expect(modelPath('easy')).toBeNull()
    for (const level of ['medium', 'hard', 'champion'] as Level[]) expect(modelPath(level)).not.toBeNull()
    const easy = await createGameAgent('easy', { seat: 1 })
    easy.reset(4)
    const traces: PuckDecisionTrace[] = []
    const withTrace = await createGameAgent('easy', { seat: 1, onDecision: (t) => traces.push(t) })
    withTrace.reset(4)
    const s = createState(4)
    for (let f = 0; f < 120; f++) {
      await withTrace.act(liveObs(s, 1), { frame: f })
      stepState(s, [NO_INPUT, NO_INPUT])
    }
    expect(traces.length).toBeGreaterThan(40)
    expect(traces.every((t) => t.bins[0] === -1 && t.bins[1] === -1)).toBe(true)
    const model = await createGameAgent('medium', { seat: 1, modelBytes: await loadBytes(MODEL), onDecision: (t) => traces.push(t) })
    model.reset(4)
    traces.length = 0
    await model.act(liveObs(createState(4), 1), { frame: 0 })
    expect(traces[0]!.bins[0]).toBeGreaterThanOrEqual(0)
    easy.dispose(); withTrace.dispose(); model.dispose()
  })

  test('Pip through the agent chooses the same targets as Pip through the shared hands on the exact delayed state (the env and page path)', async () => {
    const seed = 8
    const agent = await createGameAgent('easy', { seat: 1 })
    const traces: PuckDecisionTrace[] = []
    const probe = await createGameAgent('easy', { seat: 1, onDecision: (t) => traces.push(t) })
    probe.reset(seed)
    agent.reset(seed)
    // Reference: the page/env way, SeatHands + DelayedStates of whole states.
    const hands = new SeatHands(seed, 1, 'easy')
    const hist = botHistory(botDelayFor('easy'))!
    const s = createState(seed, { limits: [null, LEVEL_MALLET.easy] })
    hist.record(0, s)
    const pip = hands.bot('pip')
    let same = 0
    let total = 0
    let held = NO_INPUT
    for (let f = 0; f < 900 && s.matchOver === 0; f++) {
      const [code] = await probe.act(liveObs(s, 1), { frame: f })
      if (f % 2 === 0) {
        const seen = hist.view(s.frame).state
        const view = observe(seen, 1)
        view.me = observe(s, 1).me
        const want = hands.act(...pip.act(view), s.frame)
        total++
        if (want === code) same++
        else expect(Math.abs((want % 1024) - (code! % 1024)) + Math.abs(Math.floor(want / 1024) - Math.floor(code! / 1024))).toBeLessThanOrEqual(3)
      }
      if (code !== NO_INPUT) held = code!
      stepState(s, [NO_INPUT, held])
      hist.record(s.frame, s)
    }
    expect(total).toBeGreaterThan(300)
    // float32 rounding of the encoded view can move a cell by one in rare cases; it must not be the rule.
    expect(same / total).toBeGreaterThan(0.97)
    agent.dispose(); probe.dispose()
  })

  test('a published level plays its own model; a level in training plays the measured network the registry names when it ships, else the preview network (the registry decides)', () => {
    for (const level of LEVELS) {
      expect(isPublished(level)).toBe(Object.prototype.hasOwnProperty.call(puckRegistry.measured, level))
      if (level === 'easy') expect(modelPath(level)).toBeNull()
      else if (isPublished(level)) {
        // The registry names the folder: Marlow's A9 network ships in v2, Vesper's and Sable's in v1.
        const name = (puckRegistry.levels as unknown as Record<string, { config: { model: string } }>)[level]!.config.model
        const shipped = (puckRegistry.versions as unknown as Array<{ artifacts: Record<string, string> }>).map((v) => v.artifacts[name]).find((a) => a !== undefined)!
        expect(modelPath(level)).toBe(shipped.replace('apps/web/public/', ''))
        expect(modelPath(level)).toBe(`agents/puck/${level === 'medium' ? 'v2' : 'v1'}/${name}`)
      }
      else expect(modelPath(level)).toBe(level === 'medium' ? 'agents/puck/v1/hard.onnx' : PREVIEW_MODEL)
    }
  })
})

describe('browser play equals measured play', () => {
  test('champion: the agent driving the page loop plays the training env frame for frame (same inputs seen, same hash)', async () => {
    const level: Level = 'champion'
    const seed = 5150
    const ort = await OrtSession.create(await loadBytes(MODEL))
    const name = ort.inputNames[0]!
    const argmax = (xs: Float32Array) => xs.indexOf(Math.max(...Array.from(xs)))

    // Reference: the env. Seat 0 plays the scripted striker through the env's sentinel, seat 1 plays greedy ONNX on the env's own observation.
    const env = createEnv!({ n: 1, seed, level, trainCapFrames: 4000 } as never) as PuckEnv
    let obs = env.reset([seed])
    const envSeen: Float32Array[] = []
    let envHash = ''
    let envFrames = 0
    for (let d = 0; d < 3000; d++) {
      envSeen.push(obs.slice(OBS_FEATURES, 2 * OBS_FEATURES))
      const heads = Object.values(await ort.run(name, obs.slice(OBS_FEATURES, 2 * OBS_FEATURES), [1, OBS_FEATURES]))
      const out = env.step(new Int32Array([-1 - ALL_BOT_KINDS.indexOf('striker'), 0, argmax(heads[0]!), argmax(heads[1]!)]))
      if (out.done[0]) {
        const info = out.infos[0] as { finalHash: string; frames: number }
        envHash = info.finalHash
        envFrames = info.frames
        break
      }
      obs = out.obs
    }
    expect(envHash).not.toBe('')

    // The page way: SeatHands for both seats, the striker on the live state (Champion bots see the live game), the agent through act().
    const traces: PuckDecisionTrace[] = []
    const agent = await createGameAgent(level, { seat: 1, greedy: true, modelBytes: await loadBytes(MODEL), onDecision: (t) => traces.push(t) })
    agent.reset(seed)
    const s = createState(seed, { limits: [LEVEL_MALLET[level], LEVEL_MALLET[level]] })
    const hands0 = new SeatHands(seed, 0, level)
    const striker = hands0.bot('striker')
    // The env runs two sim frames per decision with the same input codes.
    let codes: [number, number] = [NO_INPUT, NO_INPUT]
    while (s.matchOver === 0 && s.frame < 4000) {
      if (s.frame % 2 === 0) {
        const t = striker.act(observe(s, 0))
        codes = [hands0.act(t[0], t[1], s.frame), NO_INPUT]
      }
      const [c1] = await agent.act(liveObs(s, 1), { frame: s.frame })
      if (s.frame % 2 === 0) codes[1] = c1!
      stepState(s, [codes[0], codes[1]])
    }
    expect(s.phase === PHASE.OVER || s.frame >= 4000).toBe(true)
    expect(s.frame).toBe(envFrames)
    expect(hashState(s)).toBe(envHash)
    expect(traces.length).toBeGreaterThan(200)
    // Each decision's model input equals the env's observation for that decision, bit for bit.
    const n = Math.min(traces.length, envSeen.length)
    for (let i = 0; i < n; i++) {
      expect(traces[i]!.frame).toBe(i * 2)
      expect(Array.from(traces[i]!.seen)).toEqual(Array.from(envSeen[i]!))
    }
    agent.dispose()
    await ort.dispose()
  }, 120_000)
})

describe('view helpers', () => {
  test('obsFromSeen inverts the trainer encoding', () => {
    const s = createState(2)
    s.px = 0.31; s.py = 1.4; s.pvx = -1.1; s.pvy = 2.2
    s.m[0]!.x = 0.7; s.m[0]!.y = 0.3
    const out = liveObs(s, 1)
    const o = obsFromSeen(out)
    const want = observe(s, 1)
    for (let i = 0; i < 4; i++) {
      expect(o.puck[i]).toBeCloseTo(want.puck[i]!, 5)
      expect(o.them[i]).toBeCloseTo(want.them[i]!, 5)
      expect(o.me[i]).toBeCloseTo(want.me[i]!, 5)
    }
    expect(o.serveToMe).toBe(want.serveToMe)
  })

  test('viewDue matches the env capture rule', () => {
    expect(viewDue(0, 9)).toEqual({ capture: true, decide: true })
    expect(viewDue(1, 9)).toEqual({ capture: true, decide: false })
    expect(viewDue(2, 9)).toEqual({ capture: false, decide: true })
    expect(viewDue(2, 18)).toEqual({ capture: true, decide: true })
  })
})
