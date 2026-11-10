import {
  DRAG_SUB, DT, MALLET_R, MALLET_REST, MAX_HITS, NEAR_MISS_SPEED, NEAR_MISS_X, PHASE, POST_L, POST_R, PUCK_MAX_SPEED,
  PUCK_R, PUCK_EVENTS, TABLE_L, TABLE_W, WALL_REST,
} from './constants'
import { emit, type Mallet, type PuckState } from './state'

// Fixed-order, allocation-free puck physics. Only + - * / sqrt abs min max floor round are used.

const RP = PUCK_R
const RM = MALLET_R
const R2 = RP + RM
const MAX2 = PUCK_MAX_SPEED * PUCK_MAX_SPEED
/** Scratch for the mallets' positions at the start of a substep and their displacement during it. */
const ox = [0, 0]
const oy = [0, 0]
const dmx = [0, 0]
const dmy = [0, 0]

/** The mallet zone for a seat (the whole mallet stays on its side of the centre line). */
export function zoneYLo(seat: number): number { return seat === 0 ? RM : 1 + RM }
export function zoneYHi(seat: number): number { return seat === 0 ? 1 - RM : TABLE_L - RM }

function moveMallet(s: PuckState, seat: number): void {
  const m = s.m[seat]!
  ox[seat] = m.x
  oy[seat] = m.y
  const ex = m.tx - m.x
  const ey = m.ty - m.y
  const dist = Math.sqrt(ex * ex + ey * ey)
  let wx = 0
  let wy = 0
  if (dist > 1e-9) {
    let want = Math.sqrt(2 * m.accel * dist)
    const arrive = dist / DT
    if (arrive < want) want = arrive
    if (m.speed < want) want = m.speed
    wx = (ex / dist) * want
    wy = (ey / dist) * want
  }
  let dvx = wx - m.vx
  let dvy = wy - m.vy
  const dv = Math.sqrt(dvx * dvx + dvy * dvy)
  const maxdv = m.accel * DT
  if (dv > maxdv) {
    dvx = (dvx / dv) * maxdv
    dvy = (dvy / dv) * maxdv
  }
  m.vx += dvx
  m.vy += dvy
  const sp = Math.sqrt(m.vx * m.vx + m.vy * m.vy)
  if (sp > m.speed) {
    m.vx = (m.vx / sp) * m.speed
    m.vy = (m.vy / sp) * m.speed
  }
  m.x += m.vx * DT
  m.y += m.vy * DT
  const lo = zoneYLo(seat)
  const hi = zoneYHi(seat)
  if (m.x < RM) { m.x = RM; m.vx = 0 } else if (m.x > TABLE_W - RM) { m.x = TABLE_W - RM; m.vx = 0 }
  if (m.y < lo) { m.y = lo; m.vy = 0 } else if (m.y > hi) { m.y = hi; m.vy = 0 }
  dmx[seat] = m.x - ox[seat]!
  dmy[seat] = m.y - oy[seat]!
}

function clampSpeed(s: PuckState): void {
  const sp2 = s.pvx * s.pvx + s.pvy * s.pvy
  if (sp2 > MAX2) {
    const k = PUCK_MAX_SPEED / Math.sqrt(sp2)
    s.pvx *= k
    s.pvy *= k
  }
}

function inMouth(x: number): boolean {
  return x > POST_L && x < POST_R
}

/** Credit a post hit or near miss to the seat that last touched the puck, only at the end that seat attacks. */
function creditAttack(s: PuckState, topEnd: boolean, kind: number): void {
  const attacker = topEnd ? 0 : 1
  if (s.lastTouch === attacker) emit(s, kind, attacker)
}

function touch(s: PuckState, seat: number): void {
  const fresh = s.lastTouch !== seat || s.frame - s.touchFrame >= 6
  s.touchFrame = s.frame
  if (!fresh) { s.lastTouch = seat; return }
  if (s.shotBy >= 0 && s.shotBy !== seat) emit(s, PUCK_EVENTS.save, seat)
  s.lastTouch = seat
  s.shotBy = -1
  // A shot on target: a straight line from here (walls ignored) crosses the other goal line where the puck centre
  // can score, which is the mouth less one puck radius at each post (a centre closer than that hits the post).
  const vy = s.pvy
  const toTop = seat === 0
  if ((toTop && vy > 0.2) || (!toTop && vy < -0.2)) {
    const t = ((toTop ? TABLE_L : 0) - s.py) / vy
    const x = s.px + s.pvx * t
    if (x > POST_L + RP && x < POST_R - RP) {
      s.shotBy = seat
      emit(s, PUCK_EVENTS.shot, seat)
    }
  }
}

/** Quadratic time of impact of a puck at (rx, ry) from a circle, moving (wx, wy) per substep, against radius rr. -1: none. */
function toi(rx: number, ry: number, wx: number, wy: number, rr: number, limit: number): number {
  const c = rx * rx + ry * ry - rr * rr
  const b = rx * wx + ry * wy
  if (c < 0) return b < 0 ? 0 : -1
  if (b >= 0) return -1
  const a = wx * wx + wy * wy
  if (a <= 0) return -1
  const disc = b * b - a * c
  if (disc < 0) return -1
  const t = (-b - Math.sqrt(disc)) / a
  return t <= limit ? (t < 0 ? 0 : t) : -1
}

const POSTS_X = [POST_L, POST_R, POST_L, POST_R]
const POSTS_Y = [0, 0, TABLE_L, TABLE_L]

/** Sweep the puck through one substep; returns the scoring seat (0 or 1) or -1. */
function sweepPuck(s: PuckState): number {
  let x = s.px
  let y = s.py
  let vx = s.pvx * DRAG_SUB
  let vy = s.pvy * DRAG_SUB
  s.pvx = vx
  s.pvy = vy
  let u = 0
  for (let iter = 0; iter < MAX_HITS; iter++) {
    const rem = 1 - u
    if (rem <= 1e-12) break
    const dx = vx * DT
    const dy = vy * DT
    let best = rem + 1e-12
    let kind = 0
    let idx = 0
    let t: number
    // 1: left wall, 2: right wall
    if (dx < 0) { t = (RP - x) / dx; if (t < 0) t = 0; if (t < best) { best = t; kind = 1 } }
    else if (dx > 0) { t = (TABLE_W - RP - x) / dx; if (t < 0) t = 0; if (t < best) { best = t; kind = 2 } }
    // 3: end wall at y = 0 side, 4: far end wall
    if (dy < 0) {
      t = (RP - y) / dy
      if (t < 0) t = 0
      if (t < best) { const xh = x + dx * t; if (xh <= POST_L || xh >= POST_R) { best = t; kind = 3 } }
    } else if (dy > 0) {
      t = (TABLE_L - RP - y) / dy
      if (t < 0) t = 0
      if (t < best) { const xh = x + dx * t; if (xh <= POST_L || xh >= POST_R) { best = t; kind = 4 } }
    }
    // 5: posts
    for (let k = 0; k < 4; k++) {
      t = toi(x - POSTS_X[k]!, y - POSTS_Y[k]!, dx, dy, RP, best)
      if (t >= 0 && t < best) { best = t; kind = 5; idx = k }
    }
    // 6: mallets
    for (let i = 0; i < 2; i++) {
      t = toi(x - (ox[i]! + u * dmx[i]!), y - (oy[i]! + u * dmy[i]!), dx - dmx[i]!, dy - dmy[i]!, R2, best)
      if (t >= 0 && t < best) { best = t; kind = 6; idx = i }
    }
    if (kind === 0) {
      x += dx * rem
      y += dy * rem
      u = 1
      break
    }
    x += dx * best
    y += dy * best
    u += best
    if (kind === 1) { x = RP; if (vx < 0) vx = -vx * WALL_REST }
    else if (kind === 2) { x = TABLE_W - RP; if (vx > 0) vx = -vx * WALL_REST }
    else if (kind === 3 || kind === 4) {
      const top = kind === 4
      if ((top && vy > 0) || (!top && vy < 0)) {
        const vn = vy < 0 ? -vy : vy
        if (vn >= NEAR_MISS_SPEED) {
          const dl = x < POST_L ? POST_L - x : x - POST_R
          if (dl < NEAR_MISS_X) { creditAttack(s, top, PUCK_EVENTS.nearMiss) }
        }
        vy = -vy * WALL_REST
      }
      y = top ? TABLE_L - RP : RP
    } else if (kind === 5) {
      const nx = (x - POSTS_X[idx]!) / RP
      const ny = (y - POSTS_Y[idx]!) / RP
      const vn = vx * nx + vy * ny
      if (vn < 0) {
        vx -= (1 + WALL_REST) * vn * nx
        vy -= (1 + WALL_REST) * vn * ny
        creditAttack(s, idx >= 2, PUCK_EVENTS.post)
      }
    } else {
      const cx = ox[idx]! + u * dmx[idx]!
      const cy = oy[idx]! + u * dmy[idx]!
      let nx = x - cx
      let ny = y - cy
      const d = Math.sqrt(nx * nx + ny * ny)
      if (d > 1e-12) { nx /= d; ny /= d } else { nx = 0; ny = idx === 0 ? 1 : -1 }
      const mvx = dmx[idx]! / DT
      const mvy = dmy[idx]! / DT
      const vn = (vx - mvx) * nx + (vy - mvy) * ny
      if (vn < 0) {
        vx -= (1 + MALLET_REST) * vn * nx
        vy -= (1 + MALLET_REST) * vn * ny
        s.pvx = vx; s.pvy = vy; s.px = x; s.py = y
        clampSpeed(s)
        vx = s.pvx; vy = s.pvy
        touch(s, idx)
      }
    }
  }
  s.px = x
  s.py = y
  s.pvx = vx
  s.pvy = vy
  clampSpeed(s)
  if (s.py <= 0 && inMouth(s.px)) return 1
  if (s.py >= TABLE_L && inMouth(s.px)) return 0
  return -1
}

/** Keep the puck on the table (never relied on in normal play; guards numeric edge cases). */
function clampPuck(s: PuckState): void {
  if (s.px < RP) s.px = RP
  else if (s.px > TABLE_W - RP) s.px = TABLE_W - RP
  if (!inMouth(s.px)) {
    if (s.py < RP) s.py = RP
    else if (s.py > TABLE_L - RP) s.py = TABLE_L - RP
  }
}

/** True if a puck centred at (x, y) would overlap neither the other seat's mallet nor a goal post. */
function spotFree(s: PuckState, seat: number, x: number, y: number): boolean {
  const o = s.m[1 - seat]!
  const ex = x - o.x
  const ey = y - o.y
  const need = R2 - 1e-9
  if (ex * ex + ey * ey < need * need) return false
  const pr = RP - 1e-9
  for (let k = 0; k < 4; k++) {
    const px = x - POSTS_X[k]!
    const py = y - POSTS_Y[k]!
    if (px * px + py * py < pr * pr) return false
  }
  return true
}

/** Where the puck can stand on a rail line, for the slide. Sets the best candidate in out; returns true if one exists. */
const cand = [0, 0]

function slidePuck(s: PuckState, m: Mallet, seat: number): boolean {
  let bestD = 1e18
  let found = false
  const lo = RP, hiX = TABLE_W - RP, hiY = TABLE_L - RP
  // vertical rails x = lo, x = hiX
  for (let k = 0; k < 2; k++) {
    const rx = k === 0 ? lo : hiX
    const dxr = rx - m.x
    const h2 = R2 * R2 - dxr * dxr
    if (h2 < 0) continue
    const h = Math.sqrt(h2)
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const ry = m.y + sgn * h
      if (ry < lo || ry > hiY) continue
      const dd = (rx - s.px) * (rx - s.px) + (ry - s.py) * (ry - s.py)
      if (dd < bestD && spotFree(s, seat, rx, ry)) { bestD = dd; cand[0] = rx; cand[1] = ry; found = true }
    }
  }
  // horizontal rails y = lo, y = hiY (only outside the mouth)
  for (let k = 0; k < 2; k++) {
    const ry = k === 0 ? lo : hiY
    const dyr = ry - m.y
    const h2 = R2 * R2 - dyr * dyr
    if (h2 < 0) continue
    const h = Math.sqrt(h2)
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const rx = m.x + sgn * h
      if (rx < lo || rx > hiX) continue
      const dd = (rx - s.px) * (rx - s.px) + (ry - s.py) * (ry - s.py)
      if (dd < bestD && spotFree(s, seat, rx, ry)) { bestD = dd; cand[0] = rx; cand[1] = ry; found = true }
    }
  }
  return found
}

/** Make sure mallet seat does not overlap the puck. Puck is pushed (or slid along a rail); if that is impossible the mallet backs off. */
function separate(s: PuckState, seat: number, puckFixed: boolean): void {
  const m = s.m[seat]!
  let nx = s.px - m.x
  let ny = s.py - m.y
  const d2 = nx * nx + ny * ny
  const need = R2 - 1e-9
  if (d2 >= need * need) return
  const d = Math.sqrt(d2)
  if (d > 1e-12) { nx /= d; ny /= d } else { nx = 0; ny = seat === 0 ? 1 : -1 }
  if (!puckFixed) {
    // 1) push the puck straight out
    const qx = m.x + nx * R2
    const qy = m.y + ny * R2
    const ok = qx >= RP && qx <= TABLE_W - RP && (inMouth(qx) || (qy >= RP && qy <= TABLE_L - RP))
    if (ok && spotFree(s, seat, qx, qy)) {
      s.px = qx; s.py = qy
      return
    }
    // 2) slide along a rail
    if (slidePuck(s, m, seat)) {
      s.px = cand[0]!; s.py = cand[1]!
      return
    }
  }
  // 3) the mallet stops at contact: back off along the normal, then slide around the zone box
  backOff(s, seat, nx, ny)
}

function backOff(s: PuckState, seat: number, nx: number, ny: number): void {
  const m = s.m[seat]!
  const lo = zoneYLo(seat)
  const hi = zoneYHi(seat)
  // Prefer to simply stay where the mallet was at the start of the substep: "the mallet stops at contact".
  const sx = ox[seat]!
  const sy = oy[seat]!
  const ddx = s.px - sx
  const ddy = s.py - sy
  if (ddx * ddx + ddy * ddy >= (R2 - 1e-9) * (R2 - 1e-9)) {
    m.x = sx
    m.y = sy
    m.vx = 0
    m.vy = 0
    return
  }
  let qx = s.px - nx * R2
  let qy = s.py - ny * R2
  const inBox = qx >= RM && qx <= TABLE_W - RM && qy >= lo && qy <= hi
  if (!inBox) {
    // nearest point on the zone box boundary that is R2 from the puck
    let bestD = 1e18
    for (let k = 0; k < 4; k++) {
      const horizontal = k >= 2
      const line = k === 0 ? RM : k === 1 ? TABLE_W - RM : k === 2 ? lo : hi
      const off = horizontal ? line - s.py : line - s.px
      const h2 = R2 * R2 - off * off
      if (h2 < 0) continue
      const h = Math.sqrt(h2)
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        const cx = horizontal ? s.px + sgn * h : line
        const cy = horizontal ? line : s.py + sgn * h
        if (cx < RM || cx > TABLE_W - RM || cy < lo || cy > hi) continue
        const dd = (cx - m.x) * (cx - m.x) + (cy - m.y) * (cy - m.y)
        if (dd < bestD) { bestD = dd; qx = cx; qy = cy }
      }
    }
  }
  m.x = qx
  m.y = qy
  m.vx = 0
  m.vy = 0
}

/** One substep: mallets move; in LIVE the puck is swept and a goal may fire. Returns the scoring seat or -1. */
export function substep(s: PuckState): number {
  moveMallet(s, 0)
  moveMallet(s, 1)
  if (s.phase !== PHASE.LIVE) {
    separate(s, 0, true)
    separate(s, 1, true)
    return -1
  }
  const scorer = sweepPuck(s)
  if (scorer >= 0) return scorer
  clampPuck(s)
  separate(s, 0, false)
  separate(s, 1, false)
  // A mallet may have shoved the puck over the line (an own goal), so look again.
  if (s.py <= 0 && inMouth(s.px)) return 1
  if (s.py >= TABLE_L && inMouth(s.px)) return 0
  clampPuck(s)
  return -1
}
