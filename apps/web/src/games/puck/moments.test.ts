import { describe, expect, test } from 'bun:test'
import { MALLET_R, NO_INPUT, PHASE, POST_L, PUCK_EVENTS, PUCK_R } from '@duelwise/core/src/games/puck/constants'
import { stepState } from '@duelwise/core/src/games/puck/core'
import { encodePuckInput } from '@duelwise/core/src/games/puck/input'
import { createState, type PuckState } from '@duelwise/core/src/games/puck/state'
import { momentFor, pillAnchor, suddenMoment } from './moments'

const IDLE: [number, number] = [NO_INPUT, NO_INPUT]
const aim = (x: number, y: number): number => encodePuckInput({ tx: x, ty: y })

/**
 * A REAL sim state at the tick an event fires: a table set up so the sim itself raises `kind` for `seat`, stepped with stepState
 * (which stamps lastEventFrame inside the tick and then advances frame, so lastEventFrame is frame - 1 here exactly as in play).
 */
function after(kind: number, seat: number, score: [number, number]): PuckState {
  const s = createState(7)
  s.phase = PHASE.LIVE
  s.phaseFrame = 0
  s.score[0] = score[0]; s.score[1] = score[1]
  // `score` is the score once the event has happened, so a goal starts one short.
  if (kind === PUCK_EVENTS.goal) s.score[seat] = s.score[seat]! - 1
  s.m[0]!.x = 0.1; s.m[0]!.y = 0.1; s.m[0]!.tx = 0.1; s.m[0]!.ty = 0.1
  s.m[1]!.x = 0.9; s.m[1]!.y = 1.9; s.m[1]!.tx = 0.9; s.m[1]!.ty = 1.9
  const toward = seat === 0 ? 1 : -1
  const y0 = seat === 0 ? 1.5 : 0.5
  s.lastTouch = seat
  let inputs = IDLE
  if (kind === PUCK_EVENTS.goal) { s.px = 0.5; s.py = y0; s.pvy = 3 * toward }
  else if (kind === PUCK_EVENTS.post) { s.px = POST_L + 0.01; s.py = y0; s.pvy = 3 * toward }
  else if (kind === PUCK_EVENTS.nearMiss) { s.px = POST_L - 0.04; s.py = y0; s.pvy = 3 * toward }
  else if (kind === PUCK_EVENTS.foul) { s.px = 0.5; s.py = seat === 0 ? 0.6 : 1.4; s.lastTouch = -1 }
  else {
    // A shot up the middle, then the defender parks its mallet in the lane: a save. For a save `seat` is the saver (as the sim credits it).
    const shooter = kind === PUCK_EVENTS.save ? 1 - seat : seat
    const hit = s.m[shooter]!
    hit.x = 0.5; hit.y = shooter === 0 ? 0.3 : 1.7; hit.tx = hit.x; hit.ty = hit.y
    s.px = 0.5; s.py = hit.y + (shooter === 0 ? 1 : -1) * (MALLET_R + PUCK_R + 0.02); s.pvx = 0; s.pvy = 0
    s.lastTouch = -1
    inputs = shooter === 0 ? [aim(512, 900), NO_INPUT] : [NO_INPUT, aim(512, 900)]
    if (kind === PUCK_EVENTS.save) {
      const d = s.m[seat]!
      d.x = 0.5; d.y = seat === 1 ? 1.6 : 0.4; d.tx = d.x; d.ty = d.y
    }
  }
  for (let i = 0; i < 3000; i++) {
    stepState(s, inputs)
    if (kind === PUCK_EVENTS.shot || kind === PUCK_EVENTS.save) inputs = IDLE
    if ((s.ev & (1 << kind)) !== 0) {
      if (kind === PUCK_EVENTS.save && s.lastEventSeat !== seat) throw new Error('wrong saver')
      return s
    }
  }
  throw new Error(`the sim never raised event ${kind} for seat ${seat}`)
}
const G = PUCK_EVENTS.goal

describe('momentFor', () => {
  test('no event, no moment', () => {
    const s = after(G, 0, [1, 0]); s.ev = 0
    expect(momentFor(s, 1)).toBeNull()
  })
  test('an ordinary goal says nothing (the score does)', () => {
    expect(momentFor(after(G, 0, [2, 1]), 1)).toBeNull()
  })
  test('your goal to 6 against fewer is match point, in your colour', () => {
    expect(momentFor(after(G, 0, [6, 3]), 4)).toEqual({ id: 4, text: 'Match point', tone: 'you' })
  })
  test('their goal to 6 is match point against you', () => {
    expect(momentFor(after(G, 1, [2, 6]), 5)).toEqual({ id: 5, text: 'Match point against you', tone: 'them' })
  })
  test('a goal that makes it 6 to 6 is next goal wins', () => {
    expect(momentFor(after(G, 0, [6, 6]), 6)?.text).toBe('Next goal wins')
    expect(momentFor(after(G, 1, [6, 6]), 6)?.text).toBe('Next goal wins')
  })
  test('the goal that ends the match speaks no moment', () => {
    expect(momentFor(after(G, 1, [6, 7]), 1)).toBeNull()
  })
  test('their goal while you already sat on 6 is not a second match point', () => {
    expect(momentFor(after(G, 1, [6, 4]), 1)).toBeNull()
  })
  test('your post is "Off the post!" at any score', () => {
    expect(momentFor(after(PUCK_EVENTS.post, 0, [0, 0]), 2)).toEqual({ id: 2, text: 'Off the post!', tone: 'you' })
  })
  test('their post names them', () => {
    expect(momentFor(after(PUCK_EVENTS.post, 1, [3, 2]), 2, 'Sable')).toEqual({ id: 2, text: 'Sable hit the post', tone: 'them' })
  })
  test('a near miss or save speaks only when the game is tight', () => {
    expect(momentFor(after(PUCK_EVENTS.nearMiss, 0, [0, 0]), 1)).toBeNull()
    expect(momentFor(after(PUCK_EVENTS.save, 0, [1, 4]), 1)).toBeNull()
    expect(momentFor(after(PUCK_EVENTS.nearMiss, 0, [5, 5]), 1)?.text).toBe('Just wide!')
    expect(momentFor(after(PUCK_EVENTS.save, 0, [5, 6]), 1)?.text).toBe('Great save')
    expect(momentFor(after(PUCK_EVENTS.save, 1, [5, 6]), 1, 'Sable')?.text).toBe('Sable saves')
  })
  test('a shot or a foul never flashes', () => {
    expect(momentFor(after(PUCK_EVENTS.shot, 0, [5, 5]), 1)).toBeNull()
    expect(momentFor(after(PUCK_EVENTS.foul, 0, [5, 5]), 1)).toBeNull()
  })
  test('an event that is not from this frame is ignored', () => {
    const s = after(PUCK_EVENTS.post, 0, [5, 5]); s.lastEventFrame = s.frame - 5
    expect(momentFor(s, 1)).toBeNull()
  })
  test('the real sim stamps an event one frame behind frame, and a post, near miss and save still flash from it', () => {
    const post = after(PUCK_EVENTS.post, 0, [5, 5])
    expect(post.lastEventFrame).toBe(post.frame - 1)
    expect(momentFor(post, 1)?.text).toBe('Off the post!')
    expect(momentFor(after(PUCK_EVENTS.nearMiss, 0, [5, 5]), 1)?.text).toBe('Just wide!')
    expect(momentFor(after(PUCK_EVENTS.nearMiss, 1, [5, 5]), 1, 'Sable')?.text).toBe('Sable just missed')
    expect(momentFor(after(PUCK_EVENTS.save, 0, [5, 5]), 1)?.text).toBe('Great save')
    expect(momentFor(after(PUCK_EVENTS.save, 1, [5, 5]), 1, 'Sable')?.text).toBe('Sable saves')
  })
  test('the tick after the event raises nothing', () => {
    const s = after(PUCK_EVENTS.post, 0, [5, 5])
    stepState(s, [NO_INPUT, NO_INPUT])
    expect(momentFor(s, 1)).toBeNull()
  })
  test('sudden death announces itself', () => {
    expect(suddenMoment(9)).toEqual({ id: 9, text: 'Next goal wins', tone: 'neutral' })
  })
  test('no copy has an em or en dash', () => {
    const all = [after(G, 0, [6, 3]), after(G, 1, [2, 6]), after(G, 0, [6, 6]), after(PUCK_EVENTS.post, 0, [0, 0]), after(PUCK_EVENTS.post, 1, [3, 2])].map((s) => momentFor(s, 1, 'Sable')?.text ?? '')
    for (const t of all) expect(t).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`))
  })
})

describe('pillAnchor', () => {
  test('the serve and moment pills sit on the centre line of the table: portrait, mid-width at the half way mark', () => {
    expect(pillAnchor({ landscape: false, x: 12, y: 84, scale: 366, edgeGuard: 0 })).toEqual({ left: 12 + 183, top: 84 + 366 })
  })
  test('landscape: the centre line is vertical, the pills are mid-height on it', () => {
    expect(pillAnchor({ landscape: true, x: 106, y: 62, scale: 314, edgeGuard: 0 })).toEqual({ left: 106 + 314, top: 62 + 157 })
  })
  test('it never sits in either goal mouth or on a mallet zone: the centre line is at least half a table width from both end walls', () => {
    for (const l of [{ landscape: false, x: 10, y: 80, scale: 300, edgeGuard: 0 }, { landscape: true, x: 100, y: 60, scale: 300, edgeGuard: 0 }]) {
      const a = pillAnchor(l)
      const along = l.landscape ? a.left - l.x : a.top - l.y
      expect(along).toBe(l.scale)
    }
  })
})
