import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildReportBody } from './build'
import { layoutLabels, type LabelIn } from './chart-labels'
import { emptyReviewText, reportTiles } from './copy'
import { playRandom, playScript } from './testing'
import { WordGrid } from './WordGrid'
import { FourBoard } from './FourBoard'
import { feedLine, matchesWindow } from '../lib/copy'
import type { FourView, ReportBody } from './types'

describe('KB2 Four solver note says what was checked', () => {
  test('a short game never claims a solver check', () => {
    const rec = playScript('four', 1, [0, 3, 0, 3, 0, 3, 1, 3], 0)
    const note = buildReportBody(rec).note!
    expect(note).not.toMatch(/checked by a perfect solver/i)
    expect(note).toMatch(/before the perfect solver.s starting point \(disc 15\)/i)
    expect(note).toMatch(/did not run/i)
  })

  test('a game that reached the solver says how many positions it checked', () => {
    let rec = playRandom('four', 5, 0)
    for (let seed = 6; rec.actions.length <= 14 && seed < 40; seed++) rec = playRandom('four', seed, 0)
    expect(rec.actions.length).toBeGreaterThan(14)
    const note = buildReportBody(rec).note!
    expect(note).toMatch(/perfect solver checked/i)
    expect(note).toMatch(/from disc 15 on/)
    expect(note).toMatch(/\d+ positions?/)
  })
})

describe('KB2 Word report markers match the game', () => {
  const rows = [{ seat: 'player' as const, guess: 'crane', markers: [0, 1, 2, 0, 2] }, { seat: 'ai' as const, guess: 'slate', markers: [0, 0, 1, 2, 2] }]
  const html = renderToStaticMarkup(<WordGrid rows={rows} opponent="Sable" />)

  test('uses the game dash, ring and dot, not the old glyphs', () => {
    expect(html).toContain('data-shape="dash"')
    expect(html).toContain('data-shape="ring"')
    expect(html).toContain('data-shape="dot"')
    expect(html).not.toMatch(/[○◐●]/)
  })

  test('the ring means in the word, elsewhere; the AI column carries the persona name', () => {
    expect(html).toContain('in the word, wrong spot')
    expect(html).toContain('>Sable<')
    expect(html).not.toContain('>The AI<')
  })
})

describe('KB2 Four report names the persona', () => {
  test('board label and drop list say the persona, not the AI', () => {
    const view: FourView = { cells: [[0, 0, 0, 0, 0, 0, 0]], drops: [{ by: 'player' as const, column: 1 }, { by: 'ai' as const, column: 2 }] }
    const html = renderToStaticMarkup(<FourBoard view={view} opponent="Marlow" />)
    expect(html).toContain('Marlow plays ringed discs')
    expect(html).toContain('Marlow, column')
    expect(html).not.toMatch(/the AI/)
  })
})

describe('KB2 chart labels never collide', () => {
  const overlaps = (a: { x: number; y: number; w: number }, b: { x: number; y: number; w: number }) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < 13
  test('close marks get their own slots and stay inside the chart', () => {
    const items: LabelIn[] = [
      { x: 200, y: 100, text: '3. Qxe5+?', up: true },
      { x: 212, y: 104, text: '4. Nxe5!', up: true },
      { x: 224, y: 98, text: '5. Bc4', up: false },
      { x: 20, y: 60, text: '1. e4!', up: true },
      { x: 630, y: 60, text: '40. Qh7#', up: true },
    ]
    const out = layoutLabels(items, { w: 640, h: 240, top: 14, bottom: 214 })
    for (let i = 0; i < out.length; i++) {
      expect(out[i]!.x - out[i]!.w / 2).toBeGreaterThanOrEqual(0)
      expect(out[i]!.x + out[i]!.w / 2).toBeLessThanOrEqual(640)
      expect(out[i]!.y).toBeGreaterThanOrEqual(14)
      expect(out[i]!.y).toBeLessThanOrEqual(214)
      for (let j = i + 1; j < out.length; j++) expect(overlaps(out[i]!, out[j]!)).toBe(false)
    }
  })
})

describe('KB2 resigned reports show no invented counts', () => {
  const body = { moves: 0, blunders: null, evaluator: 'none', moments: [], durationMs: 0 } as unknown as ReportBody
  test('resigned and abandoned hide the moves and duration tiles', () => {
    expect(reportTiles({ game: 'chess', mode: 'owner', status: 'resigned' }, body)).toEqual([])
    expect(reportTiles({ game: 'chess', mode: 'owner', status: 'abandoned' }, body)).toEqual([])
  })
  test('resigned with a known duration shows only the duration', () => {
    const t = reportTiles({ game: 'chess', mode: 'owner', status: 'resigned' }, { ...body, durationMs: 65_000 })
    expect(t.map((x) => x.label)).toEqual(['Duration'])
  })
  test('a finished match keeps its tiles and the old jargon is gone', () => {
    const t = reportTiles({ game: 'chess', mode: 'owner', status: 'ready' }, { ...body, moves: 12, blunders: 2, evaluator: 'value-net', durationMs: 90_000 })
    expect(t.map((x) => x.label)).toEqual(['Your moves', 'Costly moves', 'Duration'])
    expect(JSON.stringify(t)).not.toMatch(/value net/i)
  })
  test('the empty review line is about resigning, not about moves never played', () => {
    expect(emptyReviewText('resigned', 'owner')).toBe('You resigned, so there is no move-by-move review.')
    expect(emptyReviewText('resigned', 'public')).toBe('The player resigned, so there is no move-by-move review.')
    expect(emptyReviewText('abandoned', 'owner')).not.toMatch(/played out/)
  })
  test('chess report copy has no eval jargon', () => {
    const rec = playScript('chess', 2, ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'h5e5', 'c6e5', 'f1c4', 'f8c5'], 0, 'medium', true)
    const r = buildReportBody(rec)
    expect(JSON.stringify(r)).not.toMatch(/eval units|eval swing|value net|evaluation/i)
  })
})

describe('KB2 small copy', () => {
  test('match windows are singular for one', () => {
    expect(matchesWindow(1)).toBe('last match')
    expect(matchesWindow(5)).toBe('last 5 matches')
  })
  test('latest results name the persona', () => {
    expect(feedLine({ game: 'chess', level: 'hard', outcome: 'human' })).toBe('A player beat Vesper (Hard) at Chess')
    expect(feedLine({ game: 'chess', level: 'hard', outcome: 'draw' })).toBe('A player drew Vesper (Hard) at Chess')
    expect(feedLine({ game: 'chess', level: 'hard', outcome: 'ai' })).toBe('Vesper beat a player at Chess')
  })
})
