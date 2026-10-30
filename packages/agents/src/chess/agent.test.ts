import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chessCore } from '@duelwise/core/src/games/chess/core'
import { decodeAbs } from '@duelwise/core/src/games/chess/policy-index'
import { CHAMPION_SEARCH, CHESS_LEVELS, createChampionAgent, championNodeBudget } from './agent'

const REGISTRY = JSON.parse(readFileSync(join(import.meta.dir, '../../registry/chess.json'), 'utf8'))
const MODELS = join(import.meta.dir, '../../../../apps/web/public/agents/chess/v1')

describe('Champion search budget', () => {
  test('is a node budget with no time cap, so the page and the server play the same move', () => {
    expect(CHAMPION_SEARCH.nodeBudget).toBeGreaterThan(0)
    expect(CHAMPION_SEARCH.timeCapMs).toBeUndefined()
  })
  test('keeps the measured budget when Champion is Practice', () => {
    expect(championNodeBudget({ levels: {}, unpublishedConfig: { champion: { measuredNodeBudget: 12345 } } })).toBe(12345)
  })
  test('is the budget the registry says was measured', () => {
    const config = REGISTRY.levels.champion?.config ?? REGISTRY.unpublishedConfig.champion
    expect(config.measuredNodeBudget).toBe(CHAMPION_SEARCH.nodeBudget)
    expect(config.siteTimeCapMs).toBeUndefined()
  })
  test('the registry level configs match the shipped ones', () => {
    for (const l of ['easy', 'medium', 'hard'] as const) {
      const { net, ...rest } = REGISTRY.levels[l]?.config ?? REGISTRY.unpublishedConfig[l]
      expect(net).toBe(`policy-${CHESS_LEVELS[l].band}.onnx`)
      expect(rest).toEqual(CHESS_LEVELS[l])
    }
  })
  test.if(existsSync(join(MODELS, 'value.bin')))('two fresh Champion agents play the same moves from one position', async () => {
    const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'
    const s = chessCore.init(0, { fen })
    const play = async (): Promise<string> => {
      const a = await createChampionAgent({ ttBits: 16 })
      a.reset(7)
      const [code] = await a.act(chessCore.observe(s, 0), s)
      a.dispose()
      return decodeAbs(code!)
    }
    expect(await play()).toBe(await play())
  })
})
