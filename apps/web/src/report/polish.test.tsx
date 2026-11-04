import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildReportBody } from './build'
import { layoutLabels, type LabelIn } from './chart-labels'
import { emptyReviewText, reportTiles } from './copy'
import { playRandom, playScript } from './testing'
import { WordGrid } from './WordGrid'
import { FourBoard } from './FourBoard'
import { SlackBoard } from './SlackBoard'
import { EvalChart } from './EvalChart'
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

describe('Crosscurrent chart axis and learning line', () => {
  test('the axis counts placements, one per point, and other games keep "move n" halved', () => {
    const body = buildReportBody(playRandom('slack', 3, 0))
    const n = body.series!.points.length
    const html = renderToStaticMarkup(<EvalChart series={body.series!} />)
    expect(html).toContain('placement 1')
    expect(html).toContain(`placement ${n}`)
    expect(html).not.toMatch(/move \d/)
    const chess = buildReportBody(playScript('chess', 1, ['f2f3', 'e7e5', 'g2g4', 'd8h4'], 1))
    const chessHtml = renderToStaticMarkup(<EvalChart series={chess.series!} />)
    expect(chessHtml).toContain('move 1')
    expect(chessHtml).toContain('move 2')
    expect(chessHtml).not.toContain('placement')
  })
})

describe('Crosscurrent final board', () => {
  test('names the persona, counts match the cells and corners are marked', () => {
    const body = buildReportBody(playRandom('slack', 3, 0))
    const html = renderToStaticMarkup(<SlackBoard view={body.slackView!} opponent="Marlow" />)
    expect(html.match(/<span title=/g)).toHaveLength(64)
    expect(html).toContain(`You ${body.slackView!.discs[0]} discs`)
    expect(html).toContain(`Marlow ${body.slackView!.discs[1]} discs`)
    expect(html.match(/data-corner=/g)).toHaveLength(4)
    expect(html).not.toMatch(/the AI/)
    expect(renderToStaticMarkup(<SlackBoard view={body.slackView!} viewer="public" opponent="Marlow" />)).not.toMatch(/\bYou\b/)
  })
})

describe('reports for a player who had the second move (seat 1): chess, Four in a Row and Crosscurrent', () => {
  test.each(['chess', 'four', 'slack'] as const)('%s: the outcome, the moves and the final board are read from the player\'s seat', (game) => {
    for (const seed of [3, 4, 5]) {
      const rec = playRandom(game, seed, 1)
      const body = buildReportBody(rec)
      const won = rec.result.winner === 1
      expect(body.outcome).toBe(rec.result.winner === null ? 'draw' : won ? 'win' : 'loss')
      expect(body.moves).toBe(rec.actions.filter((a) => a[1] === 1 && !(game === 'slack' && a[2] === 64)).length)
    }
  })

  test('Crosscurrent: a pale player gets pale discs, counted from seat 1, with the dark ring on them and the words to match', () => {
    const rec = playRandom('slack', 3, 1)
    const body = buildReportBody(rec)
    expect(body.slackView!.youColor).toBe('pale')
    const last = body.slackView!
    expect(rec.humanSeat).toBe(1)
    const html = renderToStaticMarkup(<SlackBoard view={last} opponent="Marlow" />)
    expect(html).toContain(`You ${last.discs[0]} discs, pale with a dark ring`)
    expect(html).toContain(`Marlow ${last.discs[1]} discs, dark with a pale ring`)
    expect(html).toContain('You: pale discs with a dark ring')
    // The player's discs (cell value 1) are painted pale.
    expect(html).toContain('background:var(--slack-pale)')
    // A dark player (seat 0) keeps the old words.
    const dark = buildReportBody(playRandom('slack', 3, 0)).slackView!
    expect(dark.youColor).toBe('dark')
    expect(renderToStaticMarkup(<SlackBoard view={dark} opponent="Marlow" />)).toContain('You: dark discs with a pale ring')
  })

  test('an older stored view with no colour reads as dark', () => {
    const view = { ...buildReportBody(playRandom('slack', 3, 0)).slackView! }
    delete view.youColor
    expect(renderToStaticMarkup(<SlackBoard view={view} opponent="Marlow" />)).toContain('You: dark discs')
  })
})
