import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildReportBody } from './build'
import { layoutLabels, type LabelIn } from './chart-labels'
import { emptyReviewText, hasGameView, reportTiles } from './copy'
import { shareCardSvg } from './share-card'
import { PenaltyMap, place } from './PenaltyMap'
import { playPairs, playRandom, playScript } from './testing'
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

describe('Twelve Yards kick map', () => {
  const rec = playPairs('penalty', 5, Array.from({ length: 40 }, (_, t): [number, number] => (t % 2 === 0 ? [[6, 6, 2, 6, 8][(t / 2) % 5]!, 1] : [2, [0, 8, 2, 6][((t - 1) / 2) % 4]!])), 0)

  test('one numbered mark per kick the player took, a word for each outcome, and every kick of the shootout in the list', () => {
    const body = buildReportBody(rec)
    const html = renderToStaticMarkup(<PenaltyMap view={body.penaltyView!} opponent="Marlow" />)
    const mine = body.penaltyView!.kicks.filter((k) => k.byMe)
    expect(html.match(/data-testid="pen-mark-\d+"/g)).toHaveLength(mine.length)
    for (const k of mine) expect(html).toContain(`data-testid="pen-mark-${k.n}" data-outcome="${k.outcome}"`)
    expect(html.match(/<li /g)).toHaveLength(body.penaltyView!.kicks.length)
    expect(html).toContain('You shot')
    expect(html).toContain('Marlow shot')
    expect(html).toContain('Your kick map. Kick 1')
    expect(html).toMatch(/a blue disc is a goal \(\d+\), a ringed disc is a save \(\d+\), a dashed ring is over the bar or wide \(\d+\)/)
  })

  test('the public map says the player and never you', () => {
    const body = buildReportBody(rec)
    const html = renderToStaticMarkup(<PenaltyMap view={body.penaltyView!} viewer="public" opponent="Marlow" />)
    expect(html).not.toMatch(/\bYou(r)?\b/)
    expect(html).toContain('The player shot')
  })

  test('kicks to one spot are spread so none hides another, and a miss sits outside the frame', () => {
    const body = buildReportBody(rec)
    const html = renderToStaticMarkup(<PenaltyMap view={body.penaltyView!} opponent="Marlow" />)
    const centres = [...html.matchAll(/data-testid="pen-mark-\d+"[^>]*><circle cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => `${m[1]},${m[2]}`)
    expect(new Set(centres).size).toBe(centres.length)
  })

  test('the tiles give goals, kicks and saves; the share card counts kicks', () => {
    const body = buildReportBody(rec)
    const tiles = reportTiles({ game: 'penalty', mode: 'owner', status: 'ready', level: 'medium' }, body)
    const labels = tiles.map((t) => t.label)
    expect(labels).toContain('Goals')
    expect(labels).toContain('Your kicks')
    expect(labels).toContain('Your saves')
    expect(tiles.find((t) => t.label === 'Goals')!.value).toBe(`${body.penaltyView!.goals[0]} to ${body.penaltyView!.goals[1]}`)
    expect(hasGameView(body)).toBe(true)
    expect(shareCardSvg({ game: 'penalty', level: 'medium', outcome: 'win', moves: 5, link: 'x' })).toContain('level, 5 kicks.')
  })
})

describe('Twelve Yards kick map: repeated kicks', () => {
  const kick = (n: number, zone: number, outcome: 'goal' | 'saved' | 'over' | 'wide') => ({ n, round: Math.ceil(n / 2), sudden: false, byMe: true, zone, dive: 2, outcome })
  // The frame as PenaltyMap draws it: left post at 36, width 248, bar at 30, ground at 168; each spot 82.67 by 46.
  test('kicks to one spot stay inside that spot, six of them too, and none sits on another', () => {
    for (const zone of [0, 2, 4, 8]) {
      const col = zone % 3
      const row = Math.floor(zone / 3)
      for (const count of [2, 3, 4, 5, 6, 7, 9, 12]) {
        const r = count > 6 ? 8 : 9
        const pts = Array.from({ length: count }, (_, i) => place(kick(2 * i + 1, zone, 'goal'), i, count))
        for (const p of pts) {
          expect(p.x - r, `zone ${zone}, ${count} kicks: left edge`).toBeGreaterThanOrEqual(36 + col * 82.67)
          expect(p.x + r, `zone ${zone}, ${count} kicks: right edge`).toBeLessThanOrEqual(36 + (col + 1) * 82.67)
          expect(p.y - r).toBeGreaterThanOrEqual(30 + row * 46 - 1)
          expect(p.y + r).toBeLessThanOrEqual(30 + (row + 1) * 46 + 1)
        }
        for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) expect(Math.hypot(pts[a]!.x - pts[b]!.x, pts[a]!.y - pts[b]!.y), `${count} kicks, ${a} and ${b}`).toBeGreaterThanOrEqual(count > 6 ? 15 : 18)
      }
    }
  })
  test('misses stay inside the picture and apart: wide beside the post, over above the bar', () => {
    for (const zone of [2, 5, 8, 0, 3, 6]) {
      for (const outcome of ['wide', 'over'] as const) {
        const pts = Array.from({ length: 5 }, (_, i) => place(kick(2 * i + 1, zone, outcome), i, 5))
        for (const p of pts) {
          expect(p.x - 9).toBeGreaterThanOrEqual(0)
          expect(p.x + 9).toBeLessThanOrEqual(320)
          expect(p.y - 9).toBeGreaterThanOrEqual(0)
        }
        for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) expect(Math.hypot(pts[a]!.x - pts[b]!.x, pts[a]!.y - pts[b]!.y)).toBeGreaterThanOrEqual(12)
      }
    }
  })
})
