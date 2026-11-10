import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Level } from '@duelwise/core/src/product'
import { ARENA_BARS } from './arena'
import { BARS, GATE_MATCHES, gateLevel, type BotRow } from './fighter'
import { wilson } from './ladder'
import { PUCK_BARS } from './puck'

// JC3: the registries' gate rows are the eval output, and what is published follows from them. A level whose rows
// clear every bar (Wilson lower bound, 400 matches) is published and measured; any other level is not.

interface Reg {
  levels: Record<string, unknown>
  measured: Record<string, { value: number; n: number; ci95: [number, number] }>
  unpublished?: Record<string, string>
  versions: Array<{ gate: null | { levels: Record<string, { bots: Array<{ bot: string; wins: number; draws: number; losses: number; score: number; lower: number; bar: number | null }> | null }> } }>
}
const load = (game: string): Reg => JSON.parse(readFileSync(join(import.meta.dir, `../../registry/${game}.json`), 'utf8')) as Reg

for (const [game, allBars] of [['fighter', BARS], ['arena', ARENA_BARS], ['puck', PUCK_BARS]] as const) {
  describe(`${game} registry gate rows`, () => {
    const reg = load(game)
    const bars = allBars
    const gate = reg.versions[0]!.gate?.levels ?? {}
    for (const level of ['easy', 'medium', 'hard', 'champion'] as Level[]) {
      test(`${level}: rows are consistent, and published exactly when every bar is cleared`, () => {
        const detail = gate[level]?.bots
        if (!detail) {
          expect(reg.levels[level]).toBeUndefined()
          return
        }
        const rows: BotRow[] = detail.map((d) => {
          const games = d.wins + d.draws + d.losses
          expect(d.score).toBeCloseTo((d.wins + 0.5 * d.draws) / games, 5)
          expect(d.lower).toBeCloseTo(wilson(d.wins + 0.5 * d.draws, games)[0], 5)
          expect(d.bar).toBe(bars[level][d.bot] ?? null)
          const bySeat = (d as { bySeat?: BotRow['bySeat'] }).bySeat
          return { bot: d.bot, games, wins: d.wins, draws: d.draws, losses: d.losses, score: d.score, ci95: wilson(d.wins + 0.5 * d.draws, games), ...(bySeat ? { bySeat } : {}) }
        })
        // KC2: the arena gate needs each seat to clear every bar by itself (rows with no bySeat, from before KC2, are still read by the old rule).
        const perSeat = rows.every((r) => r.bySeat !== undefined)
        const verdict = gateLevel(level, rows, bars, perSeat)
        const published = Boolean(reg.levels[level])
        if (published) {
          expect(verdict.passed).toBe(true)
          const m = reg.measured[level]!
          // n is the games on the weakest seat (the publisher plays GATE_MATCHES per seat per bot), so it is GATE_MATCHES for both games.
          expect(m.n).toBe(GATE_MATCHES)
          expect(m.value).toBeCloseTo(verdict.weakest.score, 5)
          expect(reg.unpublished?.[level]).toBeUndefined()
        } else {
          expect(reg.measured[level]).toBeUndefined()
          expect(reg.unpublished?.[level]).toBeTruthy()
        }
        // A level is never published without its rows clearing the bars (it may stay unpublished for the Levels rule or a non-gated snapshot).
        if (!verdict.passed) expect(published).toBe(false)
      })
    }
  })
}

// KC3: the registry rows ARE the eval output. The eval_bots.py JSON of every measured level is kept next to the
// registry (packages/agents/eval/<game>/<level>.json); the registry's wins, draws and losses per bot and per seat equal it,
// and a published level has an eval file. R35: nothing is published from rows that are not in the current eval.
const EVAL_DIR = join(import.meta.dir, '../../eval')
for (const game of ['fighter', 'arena', 'puck'] as const) {
  describe(`${game} registry rows equal the eval output`, () => {
    const reg = load(game)
    const gate = reg.versions[0]!.gate?.levels ?? {}
    for (const level of ['easy', 'medium', 'hard', 'champion'] as Level[]) {
      test(`${level}: published only with an eval file, and every row matches it`, () => {
        const file = join(EVAL_DIR, game, `${level}.json`)
        if (!existsSync(file)) {
          expect(reg.levels[level], `${game} ${level} is published with no eval file in packages/agents/eval`).toBeUndefined()
          return
        }
        const evalRows = JSON.parse(readFileSync(file, 'utf8')) as Array<{ bot: string; wins: number; draws: number; losses: number; bySeat?: Record<string, { wins: number; draws: number; losses: number }> }>
        const rows = (gate[level]?.bots ?? []) as Array<{ bot: string; wins: number; draws: number; losses: number; bySeat?: Record<string, { wins: number; draws: number; losses: number }> }>
        expect(rows.map((r) => r.bot)).toEqual(evalRows.map((r) => r.bot))
        for (const e of evalRows) {
          const r = rows.find((x) => x.bot === e.bot)!
          expect([e.bot, r.wins, r.draws, r.losses]).toEqual([e.bot, e.wins, e.draws, e.losses])
          for (const seat of Object.keys(e.bySeat ?? {})) {
            const a = e.bySeat![seat]!
            const b = r.bySeat?.[seat]
            expect([e.bot, seat, b?.wins, b?.draws, b?.losses]).toEqual([e.bot, seat, a.wins, a.draws, a.losses])
          }
        }
      })
    }
  })

  describe(`${game} unpublished reasons name only bots the level failed`, () => {
    const reg = load(game)
    const gate = reg.versions[0]!.gate?.levels ?? {}
    const botNames = ['random', 'rushdown', 'turtle', 'zoner', 'throwloop', 'backwalk', 'pokeloop', 'sweepspam', 'fireball', 'rusher', 'holder', 'peeker', 'strafe', 'holdangle', 'striker', 'goalie', 'banker', 'shadow']
    for (const level of ['easy', 'medium', 'hard', 'champion'] as Level[]) {
      test(`${level}: a bot named in the reason is one it failed`, () => {
        // The "trails Hard" comparison names bots by head-to-head score, not by gate failure.
        const reason = reg.unpublished?.[level]?.split("Champion trails Hard")[0]
        const detail = gate[level]?.bots
        if (!reason || !detail) return
        const failed = new Set(detail.filter((d) => d.bar !== null && (d.lower < d.bar || Object.values((d as { bySeat?: Record<string, { lower: number }> }).bySeat ?? {}).some((s) => s.lower < d.bar!))).map((d) => d.bot))
        for (const b of botNames) {
          if (new RegExp(`\\b${b}\\b`).test(reason)) expect(failed.has(b), `${game} ${level} reason names ${b}, which it did not fail`).toBe(true)
        }
      })
    }
  })
}
