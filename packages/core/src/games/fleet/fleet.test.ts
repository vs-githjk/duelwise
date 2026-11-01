import { describe, expect, test } from 'bun:test'
import { fleetCore, FLEET_SIZE, SHIPS, type FleetAction, type FleetState } from './index'
import { makeRng } from '../../rng'

type Pair = [number | null, number | null]
type ObjPair = [FleetAction | null, FleetAction | null]

/** The first half of this file speaks in codes; these wrappers decode and encode at the boundary. */
const step = (s: FleetState, a: Pair): FleetState =>
  fleetCore.step(s, a.map((c) => (c === null ? null : fleetCore.decodeAction(c))) as ObjPair)
const legal = (s: FleetState, seat: 0 | 1): number[] => fleetCore.legal(s, seat).map((x) => fleetCore.encodeAction(x))

const place = (cell: number, vertical = false): number => cell + (vertical ? 100 : 0)

/** Rows of fixed legal fleets: ship i sits on row 2*i, horizontal, starting at column 0. */
const rowFleet = (): number[] => SHIPS.map((_, i) => place(i * 2 * FLEET_SIZE))

function setupBoth(a: number[], b: number[]): FleetState {
  let s = fleetCore.init(1)
  for (let t = 0; t < SHIPS.length; t++) s = step(s, [a[t]!, b[t]!])
  return s
}

function shoot(s: FleetState, cell: number): FleetState {
  const seat = fleetCore.toAct(s)[0]!
  const acts: Pair = [null, null]
  acts[seat] = 200 + cell
  return step(s, acts)
}

describe('fleet core: setup', () => {
  test('starts in setup with both seats acting', () => {
    const s = fleetCore.init(7)
    expect(fleetCore.id as string).toBe('fleet')
    expect(fleetCore.version).toBe('fleet-1')
    expect(fleetCore.toAct(s)).toEqual([0, 1])
    expect(fleetCore.terminal(s)).toBe(false)
    expect(fleetCore.result(s)).toBeNull()
    expect(fleetCore.observe(s, 0).phase).toBe('setup')
  })

  test('first legal placements fit the board for the length-5 carrier', () => {
    const s = fleetCore.init(0)
    const codes = legal(s, 0)
    // horizontal: 10 rows x 6 columns = 60; vertical: 6 rows x 10 columns = 60
    expect(codes.length).toBe(120)
    expect(codes.every((c) => c >= 0 && c < 200)).toBe(true)
  })

  test('off-board ship is illegal and throws', () => {
    const s = fleetCore.init(0)
    // length 5 starting at column 6 runs past column 9
    expect(legal(s, 0)).not.toContain(place(6))
    expect(() => step(s, [place(6), place(0)])).toThrow()
    // vertical from row 6 runs past row 9
    expect(() => step(s, [place(60, true), place(0)])).toThrow()
  })

  test('overlap is illegal but touching is fine', () => {
    let s = fleetCore.init(0)
    s = step(s, [place(0), place(0)])
    // length 4 placed over row 0 column 2 overlaps the first ship
    expect(legal(s, 0)).not.toContain(place(2))
    expect(() => step(s, [place(2), place(10)])).toThrow()
    // directly below (touching) is legal
    expect(legal(s, 0)).toContain(place(10))
    expect(() => step(s, [place(10), place(10)])).not.toThrow()
  })

  test('setup needs both seats and rejects an extra action', () => {
    const s = fleetCore.init(0)
    expect(() => step(s, [place(0), null])).toThrow()
    expect(() => step(s, [null, null])).toThrow()
  })

  test('five setup ticks move to play, seat 0 to shoot', () => {
    const s = setupBoth(rowFleet(), rowFleet())
    expect(fleetCore.toAct(s)).toEqual([0])
    expect(legal(s, 1)).toEqual([])
    expect(legal(s, 0).length).toBe(FLEET_SIZE * FLEET_SIZE)
    expect(fleetCore.observe(s, 0).phase).toBe('play')
  })
})

describe('fleet core: play', () => {
  const play = () => setupBoth(rowFleet(), rowFleet())

  test('shots alternate and a hit does not grant another shot', () => {
    let s = play()
    expect(fleetCore.toAct(s)).toEqual([0])
    s = shoot(s, 0) // hit on seat 1's row-0 carrier
    expect(fleetCore.observe(s, 0).shots[0]).toEqual({ cell: 0, hit: true, sunk: null })
    expect(fleetCore.toAct(s)).toEqual([1])
    s = shoot(s, 99) // a miss
    expect(fleetCore.toAct(s)).toEqual([0])
  })

  test('only the seat to act may shoot', () => {
    const s = play()
    expect(() => step(s, [null, 200])).toThrow()
    expect(() => step(s, [200, 201])).toThrow()
  })

  test('a repeat shot is illegal', () => {
    let s = play()
    s = shoot(s, 5)
    s = shoot(s, 5) // seat 1 may shoot cell 5 on seat 0's board once
    expect(legal(s, 0)).not.toContain(205)
    expect(() => step(s, [205, null])).toThrow()
    expect(legal(s, 1)).not.toContain(205)
  })

  test('setup codes are not legal in play and shot codes are not legal in setup', () => {
    const s = play()
    expect(() => step(s, [place(0), null])).toThrow()
    expect(() => step(fleetCore.init(0), [200, 200])).toThrow()
  })

  test('sinking a ship names it, then sinking all ships wins', () => {
    let s = play()
    // seat 1's fleet is rowFleet: ship i on row 2i from column 0, length SHIPS[i]
    const cells: number[] = []
    SHIPS.forEach((len, i) => {
      for (let c = 0; c < len; c++) cells.push(i * 2 * FLEET_SIZE + c)
    })
    let miss = 1 // seat 1 fires misses at row 1 (empty in rowFleet) cells 10..19, 11..
    const missCells = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 30, 31, 32, 33, 34, 35, 36]
    for (let i = 0; i < cells.length; i++) {
      s = shoot(s, cells[i]!)
      if (i === SHIPS[0]! - 1) {
        const o = fleetCore.observe(s, 0)
        expect(o.shots[o.shots.length - 1]!.sunk).toBe(0)
        expect(o.sunk).toHaveLength(1)
        expect(o.enemyLeft).toEqual([4, 3, 3, 2])
      }
      if (fleetCore.terminal(s)) break
      s = shoot(s, missCells[miss++ % missCells.length]!)
    }
    expect(fleetCore.terminal(s)).toBe(true)
    expect(fleetCore.result(s)).toEqual({ winner: 0, score: [1, 0], reason: 'fleet sunk' })
    expect(fleetCore.toAct(s)).toEqual([])
    expect(legal(s, 0)).toEqual([])
    expect(() => shoot(s, 50)).toThrow()
  })

  test('seat 1 can win too', () => {
    let s = play()
    const cells: number[] = []
    SHIPS.forEach((len, i) => {
      for (let c = 0; c < len; c++) cells.push(i * 2 * FLEET_SIZE + c)
    })
    const misses = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 30, 31, 32, 33, 34, 35, 36, 37]
    for (let i = 0; i < cells.length; i++) {
      s = shoot(s, misses[i]!)
      s = shoot(s, cells[i]!)
    }
    expect(fleetCore.result(s)).toEqual({ winner: 1, score: [0, 1], reason: 'fleet sunk' })
  })
})

describe('fleet core: determinism and codes', () => {
  function randomMatch(seed: number, onTick?: (s: FleetState) => void): { s: FleetState; codes: number[][] } {
    const rng = makeRng(seed)
    let s = fleetCore.init(seed)
    const codes: number[][] = []
    onTick?.(s)
    while (!fleetCore.terminal(s)) {
      const acts: ObjPair = [null, null]
      const tick: number[] = []
      for (const seat of fleetCore.toAct(s)) {
        const legal = fleetCore.legal(s, seat)
        expect(legal.length).toBeGreaterThan(0)
        const a = legal[rng.int(legal.length)]!
        // every code round-trips
        const code = fleetCore.encodeAction(a)
        expect(fleetCore.decodeAction(code)).toEqual(a)
        expect(fleetCore.encodeAction(fleetCore.decodeAction(code))).toBe(code)
        acts[seat] = a
        tick.push(code)
      }
      codes.push(tick)
      s = fleetCore.step(s, acts)
      onTick?.(s)
    }
    return { s, codes }
  }

  test('a full random match steps through legal, encode and decode', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { s } = randomMatch(seed)
      const r = fleetCore.result(s)!
      expect(r.winner === 0 || r.winner === 1).toBe(true)
      expect(r.score[0] + r.score[1]).toBe(1)
    }
  })

  test('same seed and actions give the same hash, other actions differ', () => {
    const a = randomMatch(42)
    const b = randomMatch(42)
    expect(fleetCore.hash(a.s)).toBe(fleetCore.hash(b.s))
    expect(fleetCore.hash(a.s)).toMatch(/^[0-9a-f]{16}$/)
    const c = randomMatch(43)
    expect(fleetCore.hash(c.s)).not.toBe(fleetCore.hash(a.s))
  })

  test('replaying the codes reproduces the hash', () => {
    const a = randomMatch(9)
    let s = fleetCore.init(9)
    for (const tick of a.codes) {
      const acts: ObjPair = [null, null]
      const seats = fleetCore.toAct(s)
      seats.forEach((seat, i) => {
        acts[seat] = fleetCore.decodeAction(tick[i]!)
      })
      s = fleetCore.step(s, acts)
    }
    expect(fleetCore.hash(s)).toBe(fleetCore.hash(a.s))
  })

  test('code ranges: 0..199 place, 200..299 shot, everything else throws', () => {
    expect(fleetCore.decodeAction(0)).toEqual({ kind: 'place', cell: 0, vertical: false })
    expect(fleetCore.decodeAction(199)).toEqual({ kind: 'place', cell: 99, vertical: true })
    expect(fleetCore.decodeAction(200)).toEqual({ kind: 'shot', cell: 0 })
    expect(fleetCore.decodeAction(299)).toEqual({ kind: 'shot', cell: 99 })
    for (const bad of [-1, 300, 1.5, NaN]) expect(() => fleetCore.decodeAction(bad)).toThrow()
    const badActions: FleetAction[] = [
      { kind: 'place', cell: 100, vertical: false },
      { kind: 'shot', cell: -1 },
    ]
    for (const a of badActions) expect(() => fleetCore.encodeAction(a)).toThrow()
  })
})
