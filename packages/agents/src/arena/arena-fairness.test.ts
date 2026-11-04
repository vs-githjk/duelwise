import { describe, expect, test } from 'bun:test'
import { arenaBotSeed } from './bot-seed'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { arenaCore, createState, stepPacked } from '@duelwise/core/src/games/arena/core'
import { createBot, ARENA_BOT_KINDS, HUMAN_PROXY_LIMITS, type BotKind } from '@duelwise/core/src/games/arena/bots'
import { buildObs } from '@duelwise/core/src/games/arena/encode'
import { PITCH_MAX_DELTA, YAW_MAX, packInput, type ArenaInput } from '@duelwise/core/src/games/arena/input'
import { copyState, blankState, PHASE, type ArenaState } from '@duelwise/core/src/games/arena/state'
import { WEAPONS } from '@duelwise/core/src/games/arena/weapons'
import { DelayedStates, HumanLimiter, LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import { ArenaEnv, OBS_FEATURES } from '@duelwise/core/src/games/arena/env'
import { ACTION_DIMS, ARENA_BOT_SENTINEL_BASE } from '@duelwise/core/src/games/arena/actions'
import { OrtSession } from '../runtime/ort-session'
import { ARENA_BARS, playArenaPairPoints } from '../measure/arena'
import { wilson } from '../measure/ladder'
import { createGameAgent, PUBLISHED_V1, type ArenaReply } from './agent'
import { seatView, viewDue, buyIdle, BUY_DECISIONS, FRAME_SKIP } from './view'

// R30 (plan/judge/coldstore-r1.md): the first gate gave its bots a delayed view of their OWN position and crosshair, so
// they could not aim and the agents "beat" them 400 to 0. The fixed gate (env.ts: live own state, only the opponent late)
// is replayed here against the agent the registry publishes. A published level must score at least the bar against every
// scripted bot; and a canary proves the harness bites, because the retired b2 Hard (published before R30) must lose to the fixed holder.

const ROOT = join(import.meta.dir, '../../../..')
const registry = JSON.parse(readFileSync(join(ROOT, 'packages/agents/registry/arena.json'), 'utf8')) as {
  levels: Record<string, unknown>
  unpublished?: Record<string, string>
}
const published = Object.keys(registry.levels) as Level[]

const flagBits = (i: ArenaInput): number => i.walk + 2 * i.crouch + 4 * i.jump + 8 * i.fire + 16 * i.reload

/**
 * One match of the agent (seat `agentSeat`) against a scripted bot. The bot is driven the way ArenaEnv.seatInput drives it: it sees
 * the opponent `delayFrames` late (below Champion) but its own position, aim and ammo live, its answer goes through the level's
 * HumanLimiter and is held for the decision's four frames (a semi-automatic trigger only on the first).
 */
async function playOne(level: Level, kind: BotKind, agentSeat: 0 | 1, seed: number, modelBytes?: Uint8Array): Promise<0 | 0.5 | 1> {
  return (await playMatch(level, kind, agentSeat, seed, modelBytes)).score
}

async function playMatch(level: Level, kind: BotKind, agentSeat: 0 | 1, seed: number, modelBytes?: Uint8Array, greedy = false): Promise<{ score: 0 | 0.5 | 1; frames: number }> {
  const botSeat = (1 - agentSeat) as 0 | 1
  const agent = await createGameAgent(level, { seat: agentSeat, modelBytes, greedy })
  agent.reset(seed)
  const cfg = LEVEL_LIMITS.arena[level]
  const botCfg = kind === 'human-proxy' ? HUMAN_PROXY_LIMITS : cfg
  const delay = kind === 'human-proxy' ? botCfg.delayFrames : level === 'champion' ? 0 : cfg.delayFrames
  const bot = createBot(kind, arenaBotSeed(seed, botSeat, kind))
  const lim = new HumanLimiter(botCfg, makeRng((seed + 7919 * (botSeat + 1)) >>> 0))
  const history = new DelayedStates<ArenaState>(delay, blankState, copyState)
  const s: ArenaState = createState(seed)
  let anchor = s.frame
  let phase: number = s.phase
  let queue: number[] = []
  let rest = 0
  let botFirst = 0
  let botRest = 0
  let botQueued = false
  let frames = 0
  try {
    while (s.matchOver === 0 && frames < 60 * 60 * 6) {
      if (s.phase !== phase) {
        phase = s.phase
        anchor = s.frame
        history.clear()
      }
      history.record(s.frame, s)
      const due = viewDue(s.frame, anchor, cfg.delayFrames, s.phase)
      if (due.capture || due.decide) {
        const r = (await agent.act(seatView(s, agentSeat), { frame: s.frame, anchor, phase: s.phase, weapon: s.players[agentSeat]!.weapon })) as ArenaReply
        if (r[2] === 1) {
          queue = [r[0]]
          rest = r[1]
        }
      }
      if (s.phase !== PHASE.ROUND_END && (s.frame - anchor) % FRAME_SKIP === 0 && (s.phase === PHASE.LIVE || (s.frame - anchor) / FRAME_SKIP < BUY_DECISIONS)) {
        const seen = history.view(s.frame)
        const view = buildObs(s, botSeat)
        view.opp = buildObs(seen.state, botSeat).opp
        const inp = bot.act(view)
        const held = lim.act([inp.move, flagBits(inp)], s.frame)
        let f = held[1]!
        if ((f & 8) !== 0 && s.phase === PHASE.LIVE && WEAPONS[s.players[botSeat]!.weapon]!.auto === 0 && !lim.trigger(s.frame)) f &= ~8
        const [yaw, pitch] = lim.aim(inp.yaw, inp.pitch, FRAME_SKIP)
        const full: ArenaInput = {
          move: held[0]!, walk: f & 1, crouch: (f >> 1) & 1, jump: (f >> 2) & 1, fire: (f >> 3) & 1, reload: (f >> 4) & 1,
          yaw: Math.max(-YAW_MAX, Math.min(YAW_MAX, yaw)), pitch: Math.max(-PITCH_MAX_DELTA, Math.min(PITCH_MAX_DELTA, pitch)), buy: inp.buy,
        }
        const buying = s.phase === PHASE.BUY
        const release = full.fire === 1 && WEAPONS[s.players[botSeat]!.weapon]!.auto === 0
        botFirst = packInput(full)
        botRest = !buying && !release ? botFirst : packInput({ ...full, buy: 0, fire: release ? 0 : full.fire })
        botQueued = true
      }
      const idle = buyIdle(s.frame, anchor, s.phase)
      const mine = s.phase === PHASE.ROUND_END || idle ? 0 : (queue.shift() ?? rest)
      const theirs = s.phase === PHASE.ROUND_END || idle || !botQueued ? 0 : s.frame - anchor >= 0 && (s.frame - anchor) % FRAME_SKIP === 0 ? botFirst : botRest
      if (s.phase !== PHASE.LIVE && s.phase !== PHASE.BUY) botQueued = false
      stepPacked(s, agentSeat === 0 ? mine : theirs, agentSeat === 0 ? theirs : mine)
      frames++
    }
  } finally {
    agent.dispose()
  }
  const r = arenaCore.result(s)
  if (!r || r.winner === null) return { score: 0.5, frames: s.frame }
  return { score: r.winner === agentSeat ? 1 : 0, frames: s.frame }
}

/** The same match played by the training env (ArenaEnv: the scripted bot on the other seat) with the same network, always taking its likeliest action. */
async function playInEnv(level: Level, kind: BotKind, agentSeat: 0 | 1, seed: number, bytes: Uint8Array): Promise<{ score: 0 | 0.5 | 1; frames: number }> {
  const session = await OrtSession.create(bytes)
  const input = session.inputNames[0]!
  const env = new ArenaEnv(1, level, false)
  try {
    let obs = env.reset([seed])
    const botHead = ARENA_BOT_SENTINEL_BASE - ARENA_BOT_KINDS.indexOf(kind)
    for (let step = 0; step < 100_000; step++) {
      const logits = Object.values(await session.run(input, obs.slice(agentSeat * OBS_FEATURES, (agentSeat + 1) * OBS_FEATURES), [1, OBS_FEATURES]))
      const act = new Int32Array(2 * ACTION_DIMS)
      act[(1 - agentSeat) * ACTION_DIMS] = botHead
      for (let d = 0; d < ACTION_DIMS; d++) act[agentSeat * ACTION_DIMS + d] = logits[d]!.indexOf(Math.max(...logits[d]!))
      const out = env.step(act)
      obs = out.obs
      const info = out.infos[0]
      if (info) return { score: info.winner === null ? 0.5 : info.winner === agentSeat ? 1 : 0, frames: info.frames as number }
    }
    throw new Error('the env match did not finish')
  } finally {
    await session.dispose()
  }
}

describe('the fixed gate bots are in the gate (R30)', () => {
  test('the env, the gate bars and the page agree on the six scripted bots, and every level has a bar against each human-proxy bot', () => {
    expect([...ARENA_BOT_KINDS]).toEqual(['random', 'rusher', 'holder', 'peeker', 'strafe', 'holdangle', 'human-proxy'])
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
      const bar = { easy: 0.35, medium: 0.5, hard: 0.6, champion: 0.75 }[level]
      for (const k of ['peeker', 'strafe', 'holdangle'] as const) expect(ARENA_BARS[level][k]).toBe(bar)
    }
  })

  test('the agent module serves only levels in the historical registry', () => {
    for (const level of PUBLISHED_V1) expect(published).toContain(level)
  })

  test('every level that is not published says why, and no published level appears in unpublished', () => {
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
      if (published.includes(level)) expect(registry.unpublished?.[level]).toBeUndefined()
      else expect(registry.unpublished?.[level], `${level} is neither published nor explained`).toMatch(/^in training: /)
    }
  })
})

describe('the fairness harness plays the match the training env plays', () => {
  // The Hard gate measured 78 and 73 of 100 in training and 63 and 62 here for the same network: this harness (and the page) held the agent's
  // last buy-phase input, a turn and a walk, through the rest of the 10 second buy phase, so the round began with the agent facing away,
  // where the env idles it. Same network, same seed, likeliest action each time: the two must play the same match to the frame.
  const hard = join(import.meta.dir, '../../test-fixtures/arena-v2-hard-b2.onnx')
  for (const [seed, seat, kind] of [[9000, 0, 'holder'], [9001, 1, 'holder'], [9002, 0, 'peeker'], [9003, 1, 'rusher'], [9004, 0, 'strafe'], [9005, 1, 'holdangle'], [9006, 0, 'holder'], [9007, 1, 'peeker']] as const) {
    test(`hard, seat ${seat}, ${kind}, seed ${seed}: same winner and same length as the env`, async () => {
      const bytes = new Uint8Array(await Bun.file(hard).arrayBuffer())
      const here = await playMatch('hard', kind, seat, seed, bytes, true)
      const env = await playInEnv('hard', kind, seat, seed, bytes)
      expect(here).toEqual(env)
    }, 120_000)
  }
})

describe('the published levels against the fixed bots', () => {
  test.skipIf(!process.env.PROXY_GAMES)('human proxy ceiling measurement against shipped Easy', async () => {
    const games = Number(process.env.PROXY_GAMES)
    let wins = 0
    let draws = 0
    const modelBytes = process.env.PROXY_MODEL ? new Uint8Array(await Bun.file(process.env.PROXY_MODEL).arrayBuffer()) : undefined
    for (let index = 0; index < games; index++) {
      const seat = process.env.PROXY_SEATS === 'both' ? (index % 2) as 0 | 1 : 1
      const result = await playOne(process.env.PROXY_LEVEL === 'medium' ? 'medium' : 'easy', 'human-proxy', seat, 9000 + index, modelBytes)
      if (result === 0) wins++
      if (result === 0.5) draws++
      console.log(`human-proxy sample ${index + 1}/${games}: wins ${wins}, draws ${draws}`)
    }
    console.log(`human-proxy wins ${wins}/${games}, draws ${draws}, win rate ${wins / games}`)
  }, 3_600_000)
  test.skipIf(!process.env.EASY_FLOOR_GAMES)('Easy floor measurement on each seat', async () => {
    const games = Number(process.env.EASY_FLOOR_GAMES)
    expect(games / 2).toBeGreaterThanOrEqual(400)
    expect(games % 2).toBe(0)
    let passed = true
    for (const [kind, bar] of Object.entries(ARENA_BARS.easy)) {
      const points = [0, 0]
      for (let index = 0; index < games; index++) {
        const seat = (index % 2) as 0 | 1
        points[seat]! += await playOne('easy', kind as BotKind, seat, 9000 + index)
      }
      const lower = points.map((score) => wilson(score, games / 2)[0])
      console.log(`Easy vs ${kind}: points ${points.join(', ')}, n ${games / 2} per seat, Wilson lower ${lower.join(', ')}, bar ${bar}`)
      passed &&= lower.every((value) => value > bar)
    }
    expect(passed).toBe(true)
  }, 3_600_000)
  test.skipIf(!process.env.EASY_PAIR_GAMES)('Medium versus Easy measurement', async () => {
    const games = Number(process.env.EASY_PAIR_GAMES)
    expect(games).toBeGreaterThanOrEqual(100)
    expect(games % 2).toBe(0)
    const bytes = new Uint8Array(await Bun.file(join(import.meta.dir, '../../../../apps/web/public/agents/arena/v1/easy.onnx')).arrayBuffer())
    const points = await playArenaPairPoints({ level: 'easy', bytes }, { level: 'medium', bytes }, games)
    console.log(`Medium vs Easy: ${points}/${games} points`)
    expect(points / games).toBeGreaterThan(0.5)
  }, 3_600_000)
  const GAMES = Number(process.env.FAIR_GAMES ?? 8)
  for (const level of published) {
    for (const kind of ARENA_BOT_KINDS) {
      const bar = ARENA_BARS[level][kind]
      if (bar === undefined) continue
      test(`${level} beats ${kind} in at least ${bar * 100} percent of ${GAMES} matches`, async () => {
        let points = 0
        for (let i = 0; i < GAMES; i++) points += await playOne(level, kind, (i % 2) as 0 | 1, Number(process.env.FAIR_SEED ?? 9000) + i)
        console.log(`${level} vs ${kind}: ${points}/${GAMES}`)
        expect(points / GAMES).toBeGreaterThanOrEqual(bar)
      }, 240_000)
    }
  }

  // The harness must bite. The b2 Hard (the weights that shipped before R30, kept as a fixture) lost 37.5 of 400 to the holder on the
  // fixed gate (the judge's probe: 0 of 20); it must lose to it here too, or this file would pass for any agent.
  test('canary: the retired b2 Hard loses to the holder on the fixed gate, so a passing level here means something', async () => {
    const bytes = new Uint8Array(await Bun.file(join(import.meta.dir, '../../test-fixtures/arena-v2-hard-b2.onnx')).arrayBuffer())
    let points = 0
    const games = 6
    for (let i = 0; i < games; i++) points += await playOne('hard', 'holder', (i % 2) as 0 | 1, 9100 + i, bytes)
    console.log(`retired b2 Hard vs holder: ${points}/${games}`)
    expect(points / games).toBeLessThan(0.6)
  }, 300_000)
})
