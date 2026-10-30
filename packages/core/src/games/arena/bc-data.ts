// Behaviour-cloning data for the arena (T10 fix round): scripted bots play seat 0 through the training env and
// every decision is written as (the observation the policy would have seen, the bot's choice in policy heads).
//
//   bun packages/core/src/games/arena/bc-data.ts --out <dir> --decisions <n> [--seed <s>] [--level champion@close] [--teachers rusher,holder]
//
// Writes <dir>/obs.f32 (little-endian float32, rows of OBS_FEATURES) and <dir>/act.u8 (rows of ACTION_DIMS bytes),
// plus <dir>/meta.json. Opponents (seat 1) rotate through random, rusher and holder so the data covers fights against each.
import { mkdirSync, writeFileSync } from 'node:fs'
import { ACTION_DIMS, ARENA_BOT_SENTINEL_BASE } from './actions'
import { ARENA_BOT_KINDS, type BotKind } from './bots'
import { ArenaEnv, OBS_FEATURES, parseLevel } from './env'

export const BC_OPPONENTS = ARENA_BOT_KINDS.filter((kind) => kind !== 'human-proxy')

export interface BcOptions {
  decisions: number
  seed: number
  level: string
  teachers: BotKind[]
  envs: number
}

export function collect(o: BcOptions): { obs: Float32Array; act: Uint8Array; rows: number } {
  if (o.teachers.includes('human-proxy')) throw new Error('human-proxy is measurement-only')
  const { level, close } = parseLevel(o.level)
  const env = new ArenaEnv(o.envs, level, close)
  const obs = new Float32Array(o.decisions * OBS_FEATURES)
  const act = new Uint8Array(o.decisions * ACTION_DIMS)
  const actions = new Int32Array(o.envs * 2 * ACTION_DIMS)
  const sentinel = (k: BotKind): number => ARENA_BOT_SENTINEL_BASE - ARENA_BOT_KINDS.indexOf(k)
  for (let i = 0; i < o.envs; i++) {
    actions[(i * 2) * ACTION_DIMS] = sentinel(o.teachers[i % o.teachers.length]!)
    actions[(i * 2 + 1) * ACTION_DIMS] = sentinel(BC_OPPONENTS[(Math.floor(i / o.teachers.length) + i) % BC_OPPONENTS.length]!)
  }
  let cur = env.reset(Array.from({ length: o.envs }, (_, i) => o.seed + i * 7919))
  let rows = 0
  while (rows < o.decisions) {
    const seen = cur
    cur = env.step(actions).obs
    for (let i = 0; i < o.envs && rows < o.decisions; i++) {
      obs.set(seen.subarray(i * 2 * OBS_FEATURES, i * 2 * OBS_FEATURES + OBS_FEATURES), rows * OBS_FEATURES)
      for (let d = 0; d < ACTION_DIMS; d++) act[rows * ACTION_DIMS + d] = env.botHeads[i * 2 * ACTION_DIMS + d]!
      rows++
    }
  }
  return { obs, act, rows }
}

if (import.meta.main) {
  const a: Record<string, string> = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 2) a[argv[i]!.replace(/^--/, '')] = argv[i + 1]!
  if (!a.out) throw new Error('--out is required')
  const teachers = (a.teachers ?? 'rusher,holder').split(',') as BotKind[]
  for (const t of teachers) if (!ARENA_BOT_KINDS.includes(t)) throw new Error(`unknown teacher ${t}`)
  const opts: BcOptions = { decisions: Number(a.decisions ?? 100_000), seed: Number(a.seed ?? 5), level: a.level ?? 'champion@close', teachers, envs: Number(a.envs ?? 32) }
  const { obs, act, rows } = collect(opts)
  mkdirSync(a.out, { recursive: true })
  writeFileSync(`${a.out}/obs.f32`, new Uint8Array(obs.buffer, obs.byteOffset, obs.byteLength))
  writeFileSync(`${a.out}/act.u8`, act)
  writeFileSync(`${a.out}/meta.json`, JSON.stringify({ rows, obsFeatures: OBS_FEATURES, actionDims: ACTION_DIMS, ...opts }))
}
