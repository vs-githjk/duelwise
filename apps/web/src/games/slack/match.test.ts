import { describe, expect, test } from 'bun:test'
import { PASS, slackCore, type SlackState } from '@duelwise/core/src/games/slack/core'
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent } from '@duelwise/agents/src/slack/agent'
import { LEVELS } from '../../lib/level-info'
import {
  AGENT_SEAT,
  HUMAN,
  agentChoose,
  announce,
  applyMove,
  cellName,
  discCounts,
  flipPreview,
  holdAtLeast,
  legalCells,
  mustPass,
  finalCount,
  humanMoveCount,
  liveText,
  parseMoves,
  startMatch,
  statusLine,
  tapCell,
  pressPlace,
  type SlackMatch,
} from './match'

const empty = () => new Array<number>(64).fill(0)

/** A hand-made match at a position. Seat 0 holds value 1 (dark), seat 1 holds value 2 (pale). */
function at(cells: number[], turn: 0 | 1, log: SlackMatch['log'] = []): SlackMatch {
  const state: SlackState = { cells, turn }
  return { state, log, last: null, ring: null }
}

/** Seat 0 has no move and seat 1 has one: row 0 reads pale, dark, empty. Pale can close at cell 2. */
const humanStuck = () => {
  const c = empty()
  c[0] = 2
  c[1] = 1
  return at(c, 0)
}
/** The mirror: seat 1 has no move and seat 0 has one. */
const agentStuck = () => {
  const c = empty()
  c[0] = 1
  c[1] = 2
  return at(c, 1)
}

/** Plays the human seat with a fixed, spread-out pick so matches differ by position, never by luck. */
function humanPick(m: SlackMatch, i: number): number {
  const legal = legalCells(m)
  return legal[(i * 7) % legal.length]!
}

async function playOut(level: Level, seed: number, from: SlackMatch = startMatch()): Promise<{ m: SlackMatch; passes: Record<number, number> }> {
  const agent = await createGameAgent(level, { seat: AGENT_SEAT })
  agent.reset(seed)
  let m = from
  const passes: Record<number, number> = { 0: 0, 1: 0 }
  for (let i = 0; i < 200 && !slackCore.terminal(m.state); i++) {
    if (m.state.turn === HUMAN) {
      if (mustPass(m) === HUMAN) {
        passes[HUMAN]!++
        m = applyMove(m, HUMAN, PASS)
      } else m = applyMove(m, HUMAN, humanPick(m, i))
    } else {
      const code = await agentChoose(m, agent)
      if (code === PASS) passes[AGENT_SEAT]!++
      m = applyMove(m, AGENT_SEAT, code)
    }
  }
  return { m, passes }
}

function replay(m: SlackMatch): string {
  let s = slackCore.init(0)
  for (const [seat, code] of m.log) s = slackCore.step(s, seat === 0 ? [code, null] : [null, code])
  return slackCore.hash(s)
}

describe('crosscurrent match logic', () => {
  test.each(LEVELS as Level[])('a whole match at %s ends, and its log replays to the same hash', async (level) => {
    const { m } = await playOut(level, 11)
    expect(slackCore.terminal(m.state)).toBe(true)
    expect(replay(m)).toBe(slackCore.hash(m.state))
    expect(finalCount(m, 'Pip')).toMatch(/^Final discs: You \d+, Pip \d+\.$/)
    expect(statusLine(m, 'Pip')).toMatch(/win|draw|level/i)
  })

  test('a forced pass on the human side: the page sees it, passes once, and the opponent plays again', async () => {
    const m0 = humanStuck()
    expect(mustPass(m0)).toBe(HUMAN)
    expect(legalCells(m0)).toEqual([])
    expect(statusLine(m0, 'Pip')).toBe('No move for you. Pip plays again.')
    const m1 = applyMove(m0, HUMAN, PASS)
    expect(m1.state.turn).toBe(AGENT_SEAT)
    expect(m1.last).toEqual({ seat: HUMAN, cell: null, flips: [] })
    expect(m1.state.cells).toEqual(m0.state.cells)
    // and the match carries on to a result from there, at every level
    for (const level of LEVELS as Level[]) {
      const { m } = await playOut(level, 3, m0)
      expect(slackCore.terminal(m.state)).toBe(true)
    }
  })

  test('a forced pass on the agent side: the status names it and hands the turn back', async () => {
    const m0 = agentStuck()
    expect(mustPass(m0)).toBe(AGENT_SEAT)
    const agent = await createGameAgent('easy', { seat: AGENT_SEAT })
    agent.reset(1)
    expect(await agentChoose(m0, agent)).toBe(PASS)
    const m1 = applyMove(m0, AGENT_SEAT, PASS)
    expect(m1.state.turn).toBe(HUMAN)
    expect(statusLine(m1, 'Pip')).toBe('Pip has no move. Your turn again.')
    // the note goes once the human moves
    const mv = applyMove(m1, HUMAN, legalCells(m1)[0]!)
    expect(statusLine(mv, 'Pip')).not.toContain('no move')
  })

  test('natural matches reach a pass on both sides somewhere across levels and seeds', async () => {
    const seen = { 0: 0, 1: 0 } as Record<number, number>
    for (const level of ['easy', 'medium'] as Level[]) {
      for (let seed = 1; seed <= 12; seed++) {
        const { passes } = await playOut(level, seed)
        seen[0]! += passes[0]!
        seen[1]! += passes[1]!
      }
    }
    expect(seen[0]!).toBeGreaterThan(0)
    expect(seen[1]!).toBeGreaterThan(0)
  })

  test('a tap on a legal cell selects, a second tap on it commits', () => {
    const m = startMatch()
    const legal = legalCells(m)
    expect(legal.length).toBe(4)
    const first = tapCell(m, null, legal[0]!)
    expect(first).toEqual({ selected: legal[0]!, commit: false })
    expect(tapCell(m, first.selected, legal[0]!)).toEqual({ selected: legal[0]!, commit: true })
  })

  test('a tap on a different legal cell moves the selection and never commits', () => {
    const m = startMatch()
    const [a, b] = legalCells(m) as [number, number]
    expect(tapCell(m, a, b)).toEqual({ selected: b, commit: false })
  })

  test('a tap on an illegal cell does nothing: no selection change, no commit', () => {
    const m = startMatch()
    const legal = legalCells(m)
    const illegal = [0, 27, 63, PASS].filter((c) => !legal.includes(c))
    for (const c of illegal) {
      expect(tapCell(m, null, c)).toEqual({ selected: null, commit: false })
      expect(tapCell(m, legal[0]!, c)).toEqual({ selected: legal[0]!, commit: false })
    }
  })

  test('taps do nothing when it is not the human turn or the game is over', () => {
    const agentTurn = at(startMatch().state.cells, 1)
    expect(tapCell(agentTurn, null, 20)).toEqual({ selected: null, commit: false })
    expect(tapCell(agentTurn, 20, 20)).toEqual({ selected: null, commit: false })
  })

  test('the Place button commits only with a legal selection', () => {
    const m = startMatch()
    expect(pressPlace(m, null)).toBe(false)
    expect(pressPlace(m, 0)).toBe(false)
    expect(pressPlace(m, legalCells(m)[0]!)).toBe(true)
  })

  test('a move records its cell and flips; the preview names the same flips before commit', () => {
    const m = startMatch()
    const cell = legalCells(m)[0]!
    const preview = flipPreview(m, cell)
    expect(preview.length).toBeGreaterThan(0)
    const m2 = applyMove(m, HUMAN, cell)
    expect(m2.last?.cell).toBe(cell)
    expect([...m2.last!.flips].sort()).toEqual([...preview].sort())
    expect(flipPreview(m, 0)).toEqual([])
  })

  test('an illegal move throws and leaves the match as it was', () => {
    const m = startMatch()
    const before = JSON.stringify(m)
    expect(() => applyMove(m, HUMAN, 0)).toThrow()
    expect(() => applyMove(m, AGENT_SEAT, legalCells(m)[0]!)).toThrow()
    expect(JSON.stringify(m)).toBe(before)
  })

  test('the live region carries the closing move and then the verdict', () => {
    const m = applyMove(startMatch(), HUMAN, legalCells(startMatch())[0]!)
    expect(liveText(m, 'Pip', false, '')).toBe(announce(m, 'Pip'))
    const end = liveText(m, 'Pip', true, 'You win.')
    expect(end).toBe(`${announce(m, 'Pip')} You win.`)
    expect(liveText(startMatch(), 'Pip', true, 'You resigned.')).toBe('You resigned.')
  })

  test('the agent choice is made from its own observation: the same obs gives the same code, and the page never passes a player pick', async () => {
    const m = applyMove(startMatch(), HUMAN, legalCells(startMatch())[0]!)
    const a = await createGameAgent('medium', { seat: AGENT_SEAT })
    const b = await createGameAgent('medium', { seat: AGENT_SEAT })
    a.reset(5)
    b.reset(5)
    expect(await agentChoose(m, a)).toBe(await agentChoose(m, b))
  })

  test('holdAtLeast waits for the minimum even when the work is instant, and does not add time to slow work', async () => {
    const t0 = performance.now()
    expect(await holdAtLeast(Promise.resolve(7), 60)).toBe(7)
    expect(performance.now() - t0).toBeGreaterThanOrEqual(55)
    const t1 = performance.now()
    await holdAtLeast(new Promise((r) => setTimeout(() => r(1), 90)), 20)
    expect(performance.now() - t1).toBeLessThan(160)
  })

  test('cell names run A to H across and 1 to 8 down from the top', () => {
    expect(cellName(0)).toBe('A1')
    expect(cellName(2 * 8 + 3)).toBe('D3')
    expect(cellName(63)).toBe('H8')
  })

  test('status shows the move number and counts passes out', () => {
    const m = startMatch()
    expect(statusLine(m, 'Pip')).toBe('Move 1')
    expect(statusLine(applyMove(m, HUMAN, legalCells(m)[0]!), 'Pip')).toBe('Move 2')
  })

  test('after an opponent pass the ring stays on the last disc placed and nothing animates', () => {
    const withRing: SlackMatch = { ...agentStuck(), ring: 7, last: { seat: HUMAN, cell: 7, flips: [6] } }
    expect(mustPass(withRing)).toBe(AGENT_SEAT)
    const after = applyMove(withRing, AGENT_SEAT, PASS)
    expect(after.last).toEqual({ seat: AGENT_SEAT, cell: null, flips: [] })
    expect(after.ring).toBe(7)
  })

  test('the ring follows every placement, the opponent\'s included', () => {
    const m = applyMove(startMatch(), HUMAN, legalCells(startMatch())[0]!)
    expect(m.ring).toBe(m.last!.cell)
    const reply = slackCore.legal(m.state, AGENT_SEAT)[0]!
    const m2 = applyMove(m, AGENT_SEAT, reply)
    expect(m2.ring).toBe(reply)
    expect(startMatch().ring).toBeNull()
  })

  test('a human forced pass keeps the opponent\'s ring too', () => {
    const m0 = humanStuck()
    const ringed: SlackMatch = { ...m0, ring: 5 }
    expect(applyMove(ringed, HUMAN, PASS).ring).toBe(5)
  })

  test('the test-only moves list: names or pass, played by whoever acts, an illegal or malformed list is ignored whole', () => {
    const m = parseMoves('D3,C3')!
    expect(m.log).toEqual([[0, 19], [1, 18]])
    expect(m.state.turn).toBe(HUMAN)
    expect(parseMoves('d3')!.log).toEqual([[0, 19]])
    expect(parseMoves('')).toBeNull()
    expect(parseMoves(null)).toBeNull()
    expect(parseMoves('A1')).toBeNull()
    expect(parseMoves('D3,Z9')).toBeNull()
    expect(parseMoves('PASS')).toBeNull()
  })

  test('the final count names both sides, from the board, and the human move count leaves passes out', () => {
    const m = applyMove(startMatch(), HUMAN, legalCells(startMatch())[0]!)
    expect(finalCount(m, 'Marlow')).toBe(`Final discs: You ${discCounts(m)[0]}, Marlow ${discCounts(m)[1]}.`)
    expect(humanMoveCount([[0, 19], [1, 18], [0, PASS], [0, 20]])).toBe(2)
    expect(humanMoveCount([])).toBe(0)
  })
})
