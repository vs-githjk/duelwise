import { describe, expect, test } from 'bun:test'
import { createFleetCore, fleetCore, FLEET_SIZE, SHIPS, shipCells, type FleetAction, type FleetState } from './index'
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
    expect(legal(s, 1)).toEqual([])
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
    for (let n = 0; n < 300; n++) expect(fleetCore.encodeAction(fleetCore.decodeAction(n))).toBe(n)
    for (const bad of [-1, 300, 1.5, NaN]) expect(() => fleetCore.decodeAction(bad)).toThrow()
    const badActions: FleetAction[] = [
      { kind: 'place', cell: 100, vertical: false },
      { kind: 'shot', cell: -1 },
    ]
    for (const a of badActions) expect(() => fleetCore.encodeAction(a)).toThrow()
  })
})

describe('fleet core: factory, purity and hash coverage', () => {
  test('createFleetCore returns fleetCore', () => {
    expect(createFleetCore()).toBe(fleetCore)
  })

  test('step does not mutate its input in setup or play', () => {
    const s0 = fleetCore.init(1)
    const before0 = JSON.stringify(s0)
    const s1 = step(s0, [place(0), place(0)])
    expect(JSON.stringify(s0)).toBe(before0)
    const p = setupBoth(rowFleet(), rowFleet())
    const beforeP = JSON.stringify(p)
    const p1 = shoot(p, 0)
    expect(JSON.stringify(p)).toBe(beforeP)
    expect(JSON.stringify(s1)).not.toBe(before0)
    expect(JSON.stringify(p1)).not.toBe(beforeP)
  })

  test('hash changes with any shot, orientation or position change', () => {
    const base = setupBoth(rowFleet(), rowFleet())
    const h = fleetCore.hash(base)
    const clone = (): FleetState => JSON.parse(JSON.stringify(base)) as FleetState
    const shot = clone()
    shot.shots[0].push(5)
    expect(fleetCore.hash(shot)).not.toBe(h)
    const shot2 = clone()
    shot2.shots[0].push(6)
    expect(fleetCore.hash(shot2)).not.toBe(fleetCore.hash(shot))
    const flipped = clone()
    flipped.ships[0][4]!.vertical = true
    expect(fleetCore.hash(flipped)).not.toBe(h)
    const moved = clone()
    moved.ships[1][4]!.cell += 1
    expect(fleetCore.hash(moved)).not.toBe(h)
  })
})

describe('fleet core: observation hides the enemy fleet', () => {
  const placementJson = (p: { id: number; length: number; cell: number; vertical: boolean }): string =>
    JSON.stringify({ id: p.id, length: p.length, cell: p.cell, vertical: p.vertical })

  /** Every ship of `other` that none of `seat`'s shots touched, so it is still entirely hidden. */
  function untouched(s: FleetState, seat: 0 | 1): FleetState['ships'][0] {
    const fired = new Set(s.shots[seat])
    return s.ships[(1 - seat) as 0 | 1].filter((p) => !shipCells(p).some((c) => fired.has(c)))
  }

  /** Same state, but one untouched enemy ship sits somewhere else that is also unshot. Null when no such spot exists. */
  function moveHidden(s: FleetState, seat: 0 | 1, rng: ReturnType<typeof makeRng>): FleetState | null {
    const other = (1 - seat) as 0 | 1
    const hidden = untouched(s, seat)
    if (hidden.length === 0) return null
    const ship = hidden[rng.int(hidden.length)]!
    const fired = new Set(s.shots[seat])
    const others = new Set<number>()
    for (const p of s.ships[other]) if (p.id !== ship.id) for (const c of shipCells(p)) others.add(c)
    const spots: { cell: number; vertical: boolean }[] = []
    for (const vertical of [false, true]) {
      for (let cell = 0; cell < FLEET_SIZE * FLEET_SIZE; cell++) {
        if (cell === ship.cell && vertical === ship.vertical) continue
        const row = Math.floor(cell / FLEET_SIZE)
        const col = cell % FLEET_SIZE
        if (vertical ? row + ship.length > FLEET_SIZE : col + ship.length > FLEET_SIZE) continue
        const cells = shipCells({ cell, vertical, length: ship.length })
        if (cells.some((c) => fired.has(c) || others.has(c))) continue
        spots.push({ cell, vertical })
      }
    }
    if (spots.length === 0) return null
    const to = spots[rng.int(spots.length)]!
    const ships: FleetState['ships'] = [s.ships[0].slice(), s.ships[1].slice()]
    ships[other] = s.ships[other].map((p) => (p.id === ship.id ? { ...p, cell: to.cell, vertical: to.vertical } : p))
    return { ships, shots: s.shots }
  }

  test('over 500 random matches no hidden enemy ship leaks and unshot cells do not change the observation', () => {
    let checks = 0
    let moved = 0
    for (let seed = 1; seed <= 500; seed++) {
      const rng = makeRng(seed * 7919)
      let s = fleetCore.init(seed)
      const visit = (st: FleetState): void => {
        const over = fleetCore.terminal(st)
        for (const seat of [0, 1] as const) {
          const o = fleetCore.observe(st, seat)
          const json = JSON.stringify(o)
          checks++
          if (over) {
            expect(o.reveal).not.toBeNull()
            continue
          }
          expect(o.reveal).toBeNull()
          // 1. No placement of an enemy ship with any unhit cell appears anywhere in the serialised observation.
          const fired = new Set(st.shots[seat])
          const sunkIds = new Set(o.sunk.map((p) => p.id))
          for (const p of st.ships[(1 - seat) as 0 | 1]) {
            const fullyHit = shipCells(p).every((c) => fired.has(c))
            if (fullyHit) continue
            // An identical placement of the seat's own is legitimately visible; only a different one proves a leak.
            if (st.ships[seat].some((m) => placementJson(m) === placementJson(p))) continue
            expect(sunkIds.has(p.id)).toBe(false)
            expect(json.includes(placementJson(p))).toBe(false)
          }
          // 2. Moving an untouched enemy ship to another unshot spot leaves the observation byte-identical.
          const alt = moveHidden(st, seat, rng)
          if (alt !== null) {
            moved++
            expect(JSON.stringify(fleetCore.observe(alt, seat))).toBe(json)
          }
        }
      }
      visit(s)
      while (!fleetCore.terminal(s)) {
        const acts: ObjPair = [null, null]
        for (const seat of fleetCore.toAct(s)) {
          const l = fleetCore.legal(s, seat)
          acts[seat] = l[rng.int(l.length)]!
        }
        s = fleetCore.step(s, acts)
        visit(s)
      }
    }
    expect(checks).toBeGreaterThan(50000)
    expect(moved).toBeGreaterThan(20000)
  }, 60000)

  test('setup observations never carry the other seat placements', () => {
    let s = fleetCore.init(3)
    for (let t = 0; t < SHIPS.length; t++) {
      s = step(s, [place(t * 2 * FLEET_SIZE), place(t, true)])
      const o = fleetCore.observe(s, 0)
      expect(o.phase).toBe(t === SHIPS.length - 1 ? 'play' : 'setup')
      expect(o.ships).toHaveLength(t + 1)
      expect(o.sunk).toEqual([])
      expect(o.reveal).toBeNull()
    }
  })
})
