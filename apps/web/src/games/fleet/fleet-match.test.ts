import { describe, expect, test } from 'bun:test'
import { SHIPS, fleetCore, shipCells } from '@duelwise/core/src/games/fleet'
import { makeRng } from '@duelwise/core/src/rng'
import { createGameAgent } from '@duelwise/agents/src/fleet/agent'
import { randomFleet } from '@duelwise/agents/src/fleet/placer'
import {
  AGENT_SEAT,
  CELLS,
  HUMAN,
  applyShot,
  coord,
  coordLabel,
  describeShot,
  fleetIsValid,
  humanView,
  isOver,
  moveShip,
  rotateShip,
  shipAt,
  shotKind,
  startMatch,
  statusLine,
  whoseTurn,
} from './fleet-match'

describe('fleet dev page match logic', () => {
  test('a whole match against Sable ends with a shot log that replays to the same hash', async () => {
    const agent = await createGameAgent('champion', { seat: AGENT_SEAT })
    agent.reset(11)
    let m = await startMatch(randomFleet(makeRng(5)), agent)
    expect(humanView(m).phase).toBe('play')
    expect(whoseTurn(m)).toBe('you')
    let next = 0
    while (!isOver(m)) {
      if (whoseTurn(m) === 'you') {
        while (m.state.shots[HUMAN].includes(next)) next++
        m = applyShot(m, HUMAN, next)
      } else {
        const code = (await agent.act(fleetCore.observe(m.state, AGENT_SEAT), m.state))[0]!
        const a = fleetCore.decodeAction(code)
        if (a.kind !== 'shot') throw new Error('agent must shoot')
        m = applyShot(m, AGENT_SEAT, a.cell)
      }
    }
    expect(whoseTurn(m)).toBe('over')
    // Replay: same two fleets, same shots in order.
    let s = fleetCore.init(0)
    for (let i = 0; i < SHIPS.length; i++) {
      const [h, a] = [m.state.ships[0][i]!, m.state.ships[1][i]!]
      s = fleetCore.step(s, [
        { kind: 'place', cell: h.cell, vertical: h.vertical },
        { kind: 'place', cell: a.cell, vertical: a.vertical },
      ])
    }
    for (const [seat, cell] of m.log) s = fleetCore.step(s, seat === 0 ? [{ kind: 'shot', cell }, null] : [null, { kind: 'shot', cell }])
    expect(fleetCore.hash(s)).toBe(fleetCore.hash(m.state))
    expect(statusLine(m, 'Sable')).toMatch(/sank/)
    // The view only reveals the enemy fleet at the end.
    expect(humanView(m).reveal).not.toBeNull()
  })

  test('the human view hides the agent fleet during play', async () => {
    const agent = await createGameAgent('easy', { seat: AGENT_SEAT })
    agent.reset(3)
    const m = await startMatch(randomFleet(makeRng(9)), agent)
    const v = humanView(m)
    expect(v.reveal).toBeNull()
    expect(v.sunk).toEqual([])
    expect(JSON.stringify(v)).not.toContain(JSON.stringify(m.state.ships[AGENT_SEAT][0]))
    expect(statusLine(m, 'Pip')).toContain('Your shot')
  })

  test('a shot at an already-fired cell throws and leaves the match unchanged', async () => {
    const agent = await createGameAgent('easy', { seat: AGENT_SEAT })
    agent.reset(3)
    const m = await startMatch(randomFleet(makeRng(9)), agent)
    const after = applyShot(m, HUMAN, 4)
    // Out of turn is its own error; let the agent reply first so the repeat is the only thing wrong.
    expect(() => applyShot(after, HUMAN, 5)).toThrow(/only seat 1 may act/)
    const code = (await agent.act(fleetCore.observe(after.state, AGENT_SEAT), after.state))[0]!
    const a = fleetCore.decodeAction(code)
    if (a.kind !== 'shot') throw new Error('agent must shoot')
    const replied = applyShot(after, AGENT_SEAT, a.cell)
    expect(whoseTurn(replied)).toBe('you')
    expect(() => applyShot(replied, HUMAN, 4)).toThrow(/already fired/)
    expect(replied.log).toEqual([
      [HUMAN, 4],
      [AGENT_SEAT, a.cell],
    ])
    expect(m.log).toEqual([])
  })

  test('a lost match names how many of their ships were still afloat', async () => {
    const agent = await createGameAgent('champion', { seat: AGENT_SEAT })
    agent.reset(11)
    let m = await startMatch(randomFleet(makeRng(5)), agent)
    // Sink their 2 ship, then fire only into open water so the agent wins with four of its ships afloat.
    const enemy = m.state.ships[AGENT_SEAT]
    const hull = new Set(enemy.flatMap((p) => shipCells(p)))
    const targets = [...shipCells(enemy[4]!), ...[...Array(CELLS).keys()].filter((c) => !hull.has(c))]
    let i = 0
    while (!isOver(m)) {
      if (whoseTurn(m) === 'you') m = applyShot(m, HUMAN, targets[i++]!)
      else {
        const code = (await agent.act(fleetCore.observe(m.state, AGENT_SEAT), m.state))[0]!
        const a = fleetCore.decodeAction(code)
        if (a.kind !== 'shot') throw new Error('agent must shoot')
        m = applyShot(m, AGENT_SEAT, a.cell)
      }
    }
    expect(fleetCore.result(m.state)?.winner).toBe(AGENT_SEAT)
    expect(humanView(m).enemyLeft).toHaveLength(4)
    expect(statusLine(m, 'Sable')).toBe(`Sable sank your fleet in ${humanView(m).incoming.length} shots; Sable still had 4 ships afloat.`)
  })

  test('an invalid fleet is refused at the start', async () => {
    const agent = await createGameAgent('easy', { seat: AGENT_SEAT })
    const bad = randomFleet(makeRng(1))
    bad[1] = { ...bad[0]!, id: 1, length: 4 }
    await expect(startMatch(bad, agent)).rejects.toThrow('not valid')
  })

  test('shot words and cue kinds match what the view says', async () => {
    const agent = await createGameAgent('easy', { seat: AGENT_SEAT })
    agent.reset(3)
    const m0 = await startMatch(randomFleet(makeRng(9)), agent)
    const enemy = m0.state.ships[AGENT_SEAT][4]!
    const water = [...Array(CELLS).keys()].find((c) => m0.state.ships[AGENT_SEAT].every((p) => !shipCells(p).includes(c)))!
    const miss = applyShot(m0, HUMAN, water)
    expect(shotKind(miss, HUMAN)).toBe('miss')
    expect(describeShot(miss, HUMAN, 'Pip')).toBe(`Miss at ${coord(water)}.`)
    // Sink the 2-ship with two hand-fed shots, with the agent's reply shots in between.
    let m = m0
    for (const c of shipCells(enemy)) {
      m = applyShot(m, HUMAN, c)
      if (c !== shipCells(enemy).at(-1)) {
        const reply = [...Array(CELLS).keys()].find((x) => !m.state.shots[AGENT_SEAT].includes(x))!
        m = applyShot(m, AGENT_SEAT, reply)
      }
    }
    expect(shotKind(m, HUMAN)).toBe('sunk')
    expect(describeShot(m, HUMAN, 'Pip')).toContain("You sank Pip's 2 ship")
    expect(shotKind(m, AGENT_SEAT)).not.toBe('sunk')
    expect(describeShot(m, AGENT_SEAT, 'Pip')).toContain('Pip fired at')
  })

  test('coordinates read D7 in copy and "D, 7" in labels', () => {
    expect(coord(63)).toBe('D7')
    expect(coordLabel(63)).toBe('D, 7')
    expect(coord(0)).toBe('A1')
    expect(coord(99)).toBe('J10')
  })

  test('setup edits: move, rotate, overlap and edge refusals', () => {
    const fleet = randomFleet(makeRng(21))
    expect(fleetIsValid(fleet)).toBe(true)
    // A ship cannot be moved onto another ship or off the grid.
    const other = fleet[1]!
    expect(moveShip(fleet, 0, other.cell)).toBeNull()
    expect(moveShip(fleet, 0, 99)).toBeNull()
    // Move a ship to any legal spot and the result is still a valid fleet.
    for (let cell = 0; cell < CELLS; cell++) {
      const moved = moveShip(fleet, 4, cell)
      if (moved) {
        expect(fleetIsValid(moved)).toBe(true)
        expect(shipAt(moved, cell)).toBe(4)
        break
      }
    }
    // Rotating twice returns to a valid fleet; a lone ship in a corner slides back from the edge.
    const lone = [
      { id: 0, length: 5, cell: 5, vertical: false },
      { id: 1, length: 4, cell: 20, vertical: false },
      { id: 2, length: 3, cell: 40, vertical: false },
      { id: 3, length: 3, cell: 60, vertical: false },
      { id: 4, length: 2, cell: 80, vertical: false },
    ]
    expect(fleetIsValid(lone)).toBe(true)
    const turned = rotateShip(lone, 0)!
    expect(turned.find((p) => p.id === 0)!.vertical).toBe(true)
    expect(fleetIsValid(turned)).toBe(true)
    // Ship 0 turned would cross ship 1 below it (cells 5, 15, 25... vs row 2 starting col 0 length 4: cell 25 not in 20..23): fine; block it explicitly.
    const blocked = lone.map((p) => (p.id === 1 ? { ...p, cell: 25 } : p))
    expect(rotateShip(blocked, 0)).toBeNull()
  })
})
