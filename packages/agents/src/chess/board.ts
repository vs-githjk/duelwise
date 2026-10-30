// A small make/unmake chess board for the Champion search. chess.js is far too slow for tens of
// thousands of nodes per second, so the search owns a flat board with precomputed attack tables.
// Squares: rank * 8 + file, a1 = 0, h1 = 7, a8 = 56. Piece codes match core position.ts:
// 1..6 = white P N B R Q K, 7..12 = black. Perft numbers in alphabeta.test.ts check the generator
// against published values, and a seeded walk compares its legal moves with the chess core.

export const WHITE = 0
export const BLACK = 1
export const PAWN = 1
export const KNIGHT = 2
export const BISHOP = 3
export const ROOK = 4
export const QUEEN = 5
export const KING = 6

/** A move: from | to << 6 | promotionType << 12 (promotionType 2..5, 0 for none). */
export type Move = number
export const moveFrom = (m: Move): number => m & 63
export const moveTo = (m: Move): number => (m >> 6) & 63
export const movePromo = (m: Move): number => (m >> 12) & 7
export const makeMove = (from: number, to: number, promo = 0): Move => from | (to << 6) | (promo << 12)

const FILES = 'abcdefgh'
export const squareName = (s: number): string => FILES[s & 7]! + String.fromCharCode(49 + (s >> 3))
const PROMO_LETTER = ['', '', 'n', 'b', 'r', 'q']

/** Canonical UCI: a queen promotion has no suffix (see core policy-index.ts). */
export function moveToUci(m: Move): string {
  const p = movePromo(m)
  return squareName(moveFrom(m)) + squareName(moveTo(m)) + (p === 0 || p === QUEEN ? '' : PROMO_LETTER[p]!)
}

const typeOf = (code: number): number => ((code - 1) % 6) + 1
const colorOf = (code: number): number => (code <= 6 ? WHITE : BLACK)
export { typeOf as pieceType, colorOf as pieceColor }

const PIECE_CODE: Record<string, number> = { P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6, p: 7, n: 8, b: 9, r: 10, q: 11, k: 12 }

// Direction tables. RAYS[sq][d] lists squares from sq outwards; d 0..3 orthogonal, 4..7 diagonal.
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, -1], [1, 0], [-1, 0],
  [1, 1], [-1, 1], [1, -1], [-1, -1],
]
const RAYS: number[][][] = []
const KNIGHT_TO: number[][] = []
const KING_TO: number[][] = []
for (let sq = 0; sq < 64; sq++) {
  const f = sq & 7
  const r = sq >> 3
  RAYS.push(
    DIRS.map(([df, dr]) => {
      const ray: number[] = []
      for (let x = f + df, y = r + dr; x >= 0 && x < 8 && y >= 0 && y < 8; x += df, y += dr) ray.push(y * 8 + x)
      return ray
    }),
  )
  const knight: number[] = []
  for (const [df, dr] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]] as const) {
    const x = f + df
    const y = r + dr
    if (x >= 0 && x < 8 && y >= 0 && y < 8) knight.push(y * 8 + x)
  }
  KNIGHT_TO.push(knight)
  const king: number[] = []
  for (const [df, dr] of DIRS) {
    const x = f + df
    const y = r + dr
    if (x >= 0 && x < 8 && y >= 0 && y < 8) king.push(y * 8 + x)
  }
  KING_TO.push(king)
}

// Castling rights lost when a piece moves from or to a square (bits: WK 1, WQ 2, BK 4, BQ 8).
const CASTLE_MASK = new Uint8Array(64).fill(15)
CASTLE_MASK[0] = 15 & ~2
CASTLE_MASK[7] = 15 & ~1
CASTLE_MASK[4] = 15 & ~3
CASTLE_MASK[56] = 15 & ~8
CASTLE_MASK[63] = 15 & ~4
CASTLE_MASK[60] = 15 & ~12

// Zobrist keys from a fixed xorshift stream: the same hashes in every run.
const ZLO = new Int32Array(13 * 64)
const ZHI = new Int32Array(13 * 64)
const CLO = new Int32Array(16)
const CHI = new Int32Array(16)
const ELO = new Int32Array(8)
const EHI = new Int32Array(8)
let SIDE_LO = 0
let SIDE_HI = 0
{
  let s = 0x2545f491
  const next = (): number => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return s | 0
  }
  for (let i = 0; i < ZLO.length; i++) {
    ZLO[i] = next()
    ZHI[i] = next()
  }
  for (let i = 0; i < 16; i++) {
    CLO[i] = next()
    CHI[i] = next()
  }
  for (let i = 0; i < 8; i++) {
    ELO[i] = next()
    EHI[i] = next()
  }
  SIDE_LO = next()
  SIDE_HI = next()
}

const MAX_HIST = 1024

export class Board {
  readonly sq = new Int8Array(64)
  side = WHITE
  castling = 0
  /** En passant target square, or -1. Set only when an enemy pawn could actually capture there. */
  ep = -1
  halfmove = 0
  fullmove = 1
  hashLo = 0
  hashHi = 0
  readonly king = [-1, -1]
  ply = 0

  private readonly hMove = new Int32Array(MAX_HIST)
  private readonly hCap = new Int8Array(MAX_HIST)
  private readonly hCastle = new Uint8Array(MAX_HIST)
  private readonly hEp = new Int8Array(MAX_HIST)
  private readonly hHalf = new Int16Array(MAX_HIST)
  /** Hash BEFORE the move at each ply, so hLo[0..ply-1] are the earlier positions of this game. */
  readonly hLo = new Int32Array(MAX_HIST)
  readonly hHi = new Int32Array(MAX_HIST)

  static fromFen(fen: string): Board {
    const b = new Board()
    const parts = fen.trim().split(/\s+/)
    if (parts.length < 4) throw new Error('bad FEN ' + JSON.stringify(fen))
    const rows = parts[0]!.split('/')
    if (rows.length !== 8) throw new Error('bad FEN board ' + JSON.stringify(fen))
    for (let i = 0; i < 8; i++) {
      let file = 0
      for (const ch of rows[i]!) {
        const d = ch.charCodeAt(0) - 48
        if (d >= 1 && d <= 8) file += d
        else {
          const code = PIECE_CODE[ch]
          if (code === undefined || file > 7) throw new Error('bad FEN board ' + JSON.stringify(fen))
          b.sq[(7 - i) * 8 + file++] = code
        }
      }
      if (file !== 8) throw new Error('bad FEN board ' + JSON.stringify(fen))
    }
    b.side = parts[1] === 'b' ? BLACK : WHITE
    for (const ch of parts[2]!) b.castling |= ch === 'K' ? 1 : ch === 'Q' ? 2 : ch === 'k' ? 4 : ch === 'q' ? 8 : 0
    const ep = parts[3]!
    b.ep = ep === '-' ? -1 : (ep.charCodeAt(1) - 49) * 8 + (ep.charCodeAt(0) - 97)
    b.halfmove = parts.length > 4 ? Number.parseInt(parts[4]!, 10) || 0 : 0
    b.fullmove = parts.length > 5 ? Number.parseInt(parts[5]!, 10) || 1 : 1
    for (let s = 0; s < 64; s++) {
      const c = b.sq[s]!
      if (typeOf(c) === KING && c !== 0) b.king[colorOf(c)] = s
    }
    if (b.king[0]! < 0 || b.king[1]! < 0) throw new Error('FEN without both kings ' + JSON.stringify(fen))
    if (b.ep >= 0 && !b.epCapturable(b.ep)) b.ep = -1
    b.computeHash()
    return b
  }

  private epCapturable(ep: number): boolean {
    // The side to move captures onto ep with a pawn standing on the rank behind it, one file aside.
    const f = ep & 7
    const row = this.side === WHITE ? ep - 8 : ep + 8
    const mine = this.side === WHITE ? 1 : 7
    return (f > 0 && this.sq[row - 1] === mine) || (f < 7 && this.sq[row + 1] === mine)
  }

  private computeHash(): void {
    let lo = 0
    let hi = 0
    for (let s = 0; s < 64; s++) {
      const c = this.sq[s]!
      if (c !== 0) {
        lo ^= ZLO[c * 64 + s]!
        hi ^= ZHI[c * 64 + s]!
      }
    }
    lo ^= CLO[this.castling]!
    hi ^= CHI[this.castling]!
    if (this.ep >= 0) {
      lo ^= ELO[this.ep & 7]!
      hi ^= EHI[this.ep & 7]!
    }
    if (this.side === BLACK) {
      lo ^= SIDE_LO
      hi ^= SIDE_HI
    }
    this.hashLo = lo
    this.hashHi = hi
  }

  /** True when `s` is attacked by a piece of colour `by`. */
  attacked(s: number, by: number): boolean {
    const sq = this.sq
    const off = by === WHITE ? 0 : 6
    // Pawns: a white pawn attacks up, so it stands one rank below s.
    const f = s & 7
    const r = s >> 3
    if (by === WHITE) {
      if (r > 0) {
        if (f > 0 && sq[s - 9] === 1) return true
        if (f < 7 && sq[s - 7] === 1) return true
      }
    } else if (r < 7) {
      if (f > 0 && sq[s + 7] === 7) return true
      if (f < 7 && sq[s + 9] === 7) return true
    }
    const kn = KNIGHT_TO[s]!
    for (let i = 0; i < kn.length; i++) if (sq[kn[i]!] === KNIGHT + off) return true
    const kg = KING_TO[s]!
    for (let i = 0; i < kg.length; i++) if (sq[kg[i]!] === KING + off) return true
    const rays = RAYS[s]!
    for (let d = 0; d < 8; d++) {
      const ray = rays[d]!
      for (let i = 0; i < ray.length; i++) {
        const c = sq[ray[i]!]!
        if (c === 0) continue
        if (c === QUEEN + off || c === (d < 4 ? ROOK : BISHOP) + off) return true
        break
      }
    }
    return false
  }

  inCheck(): boolean {
    return this.attacked(this.king[this.side]!, this.side ^ 1)
  }

  /** Pseudo-legal moves into `out` (captures and promotions only when `noisy`); returns the count. */
  generate(out: Int32Array, noisy = false): number {
    const sq = this.sq
    const side = this.side
    const off = side === WHITE ? 0 : 6
    let n = 0
    for (let from = 0; from < 64; from++) {
      const c = sq[from]!
      if (c === 0 || (c <= 6) !== (side === WHITE)) continue
      const t = c - off
      if (t === PAWN) {
        const up = side === WHITE ? 8 : -8
        const lastRank = side === WHITE ? 7 : 0
        const startRank = side === WHITE ? 1 : 6
        const f = from & 7
        const to1 = from + up
        if (sq[to1] === 0) {
          if (to1 >> 3 === lastRank) {
            for (let p = QUEEN; p >= KNIGHT; p--) {
              if (noisy && p !== QUEEN) continue
              out[n++] = makeMove(from, to1, p)
            }
          } else if (!noisy) {
            out[n++] = makeMove(from, to1)
            if (from >> 3 === startRank && sq[to1 + up] === 0) out[n++] = makeMove(from, to1 + up)
          }
        }
        for (const df of [-1, 1]) {
          if (f + df < 0 || f + df > 7) continue
          const to = to1 + df
          const tc = sq[to]!
          const enemy = tc !== 0 && (tc <= 6) !== (side === WHITE)
          if (enemy || to === this.ep) {
            if (to >> 3 === lastRank) {
              for (let p = QUEEN; p >= KNIGHT; p--) {
                if (noisy && p !== QUEEN) continue
                out[n++] = makeMove(from, to, p)
              }
            } else out[n++] = makeMove(from, to)
          }
        }
      } else if (t === KNIGHT || t === KING) {
        const list = t === KNIGHT ? KNIGHT_TO[from]! : KING_TO[from]!
        for (let i = 0; i < list.length; i++) {
          const to = list[i]!
          const tc = sq[to]!
          if (tc === 0) {
            if (!noisy) out[n++] = makeMove(from, to)
          } else if ((tc <= 6) !== (side === WHITE)) out[n++] = makeMove(from, to)
        }
        if (t === KING && !noisy) n = this.genCastles(out, n)
      } else {
        const d0 = t === BISHOP ? 4 : 0
        const d1 = t === ROOK ? 4 : 8
        const rays = RAYS[from]!
        for (let d = d0; d < d1; d++) {
          const ray = rays[d]!
          for (let i = 0; i < ray.length; i++) {
            const to = ray[i]!
            const tc = sq[to]!
            if (tc === 0) {
              if (!noisy) out[n++] = makeMove(from, to)
              continue
            }
            if ((tc <= 6) !== (side === WHITE)) out[n++] = makeMove(from, to)
            break
          }
        }
      }
    }
    return n
  }

  private genCastles(out: Int32Array, n: number): number {
    const sq = this.sq
    const side = this.side
    const them = side ^ 1
    const base = side === WHITE ? 0 : 56
    const kingHome = base + 4
    if (this.king[side] !== kingHome) return n
    const rook = side === WHITE ? ROOK : ROOK + 6
    const k = side === WHITE ? 1 : 4
    const q = side === WHITE ? 2 : 8
    if ((this.castling & (k | q)) === 0) return n
    if (this.attacked(kingHome, them)) return n
    if (this.castling & k && sq[base + 7] === rook && sq[base + 5] === 0 && sq[base + 6] === 0 && !this.attacked(base + 5, them) && !this.attacked(base + 6, them)) {
      out[n++] = makeMove(kingHome, base + 6)
    }
    if (this.castling & q && sq[base] === rook && sq[base + 1] === 0 && sq[base + 2] === 0 && sq[base + 3] === 0 && !this.attacked(base + 3, them) && !this.attacked(base + 2, them)) {
      out[n++] = makeMove(kingHome, base + 2)
    }
    return n
  }

  /** Plays a pseudo-legal move. Returns false (and leaves the board unchanged) if it leaves the mover's king attacked. */
  make(m: Move): boolean {
    const sq = this.sq
    const from = moveFrom(m)
    const to = moveTo(m)
    const promo = movePromo(m)
    const side = this.side
    const piece = sq[from]!
    const t = typeOf(piece)
    let cap = sq[to]!
    const i = this.ply
    this.hMove[i] = m
    this.hCastle[i] = this.castling
    this.hEp[i] = this.ep
    this.hHalf[i] = this.halfmove
    this.hLo[i] = this.hashLo
    this.hHi[i] = this.hashHi

    let lo = this.hashLo
    let hi = this.hashHi
    lo ^= CLO[this.castling]!
    hi ^= CHI[this.castling]!
    if (this.ep >= 0) {
      lo ^= ELO[this.ep & 7]!
      hi ^= EHI[this.ep & 7]!
    }
    lo ^= ZLO[piece * 64 + from]!
    hi ^= ZHI[piece * 64 + from]!
    this.halfmove++
    let epCapture = false
    if (t === PAWN) {
      this.halfmove = 0
      if (to === this.ep && cap === 0 && (from & 7) !== (to & 7)) {
        epCapture = true
        const capSq = side === WHITE ? to - 8 : to + 8
        cap = sq[capSq]!
        sq[capSq] = 0
        lo ^= ZLO[cap * 64 + capSq]!
        hi ^= ZHI[cap * 64 + capSq]!
      }
    }
    if (cap !== 0 && !epCapture) {
      lo ^= ZLO[cap * 64 + to]!
      hi ^= ZHI[cap * 64 + to]!
    }
    if (cap !== 0) this.halfmove = 0
    this.hCap[i] = cap
    const placed = promo !== 0 ? promo + (side === WHITE ? 0 : 6) : piece
    sq[to] = placed
    sq[from] = 0
    lo ^= ZLO[placed * 64 + to]!
    hi ^= ZHI[placed * 64 + to]!
    if (t === KING) {
      this.king[side] = to
      if (to - from === 2 || from - to === 2) {
        const rookFrom = to > from ? from + 3 : from - 4
        const rookTo = to > from ? from + 1 : from - 1
        const rook = sq[rookFrom]!
        sq[rookTo] = rook
        sq[rookFrom] = 0
        lo ^= ZLO[rook * 64 + rookFrom]! ^ ZLO[rook * 64 + rookTo]!
        hi ^= ZHI[rook * 64 + rookFrom]! ^ ZHI[rook * 64 + rookTo]!
      }
    }
    this.castling &= CASTLE_MASK[from]! & CASTLE_MASK[to]!
    this.ep = -1
    this.side ^= 1
    if (t === PAWN && (to - from === 16 || from - to === 16)) {
      const mid = (to + from) >> 1
      if (this.epCapturable(mid)) this.ep = mid
    }
    lo ^= CLO[this.castling]!
    hi ^= CHI[this.castling]!
    if (this.ep >= 0) {
      lo ^= ELO[this.ep & 7]!
      hi ^= EHI[this.ep & 7]!
    }
    lo ^= SIDE_LO
    hi ^= SIDE_HI
    this.hashLo = lo
    this.hashHi = hi
    if (side === BLACK) this.fullmove++
    this.ply++
    if (this.attacked(this.king[side]!, side ^ 1)) {
      this.unmake()
      return false
    }
    return true
  }

  unmake(): void {
    const i = --this.ply
    const m = this.hMove[i]!
    const sq = this.sq
    const from = moveFrom(m)
    const to = moveTo(m)
    const promo = movePromo(m)
    this.side ^= 1
    const side = this.side
    const moved = sq[to]!
    const piece = promo !== 0 ? (side === WHITE ? PAWN : PAWN + 6) : moved
    const cap = this.hCap[i]!
    const wasEp = typeOf(piece) === PAWN && to === this.hEp[i] && (from & 7) !== (to & 7)
    sq[from] = piece
    if (wasEp) {
      sq[to] = 0
      sq[side === WHITE ? to - 8 : to + 8] = cap
    } else sq[to] = cap
    if (typeOf(piece) === KING) {
      this.king[side] = from
      if (to - from === 2 || from - to === 2) {
        const rookFrom = to > from ? from + 3 : from - 4
        const rookTo = to > from ? from + 1 : from - 1
        sq[rookFrom] = sq[rookTo]!
        sq[rookTo] = 0
      }
    }
    this.castling = this.hCastle[i]!
    this.ep = this.hEp[i]!
    this.halfmove = this.hHalf[i]!
    this.hashLo = this.hLo[i]!
    this.hashHi = this.hHi[i]!
    if (side === BLACK) this.fullmove--
  }

  makeNull(): void {
    const i = this.ply
    this.hMove[i] = 0
    this.hEp[i] = this.ep
    this.hHalf[i] = this.halfmove
    this.hCastle[i] = this.castling
    this.hLo[i] = this.hashLo
    this.hHi[i] = this.hashHi
    if (this.ep >= 0) {
      this.hashLo ^= ELO[this.ep & 7]!
      this.hashHi ^= EHI[this.ep & 7]!
    }
    this.ep = -1
    this.hashLo ^= SIDE_LO
    this.hashHi ^= SIDE_HI
    this.side ^= 1
    this.halfmove++
    this.ply++
  }

  unmakeNull(): void {
    const i = --this.ply
    this.side ^= 1
    this.ep = this.hEp[i]!
    this.halfmove = this.hHalf[i]!
    this.hashLo = this.hLo[i]!
    this.hashHi = this.hHi[i]!
  }

  /** Legal moves of the side to move (allocates; the search uses generate and make instead). */
  legalMoves(): Move[] {
    const buf = new Int32Array(256)
    const n = this.generate(buf)
    const out: Move[] = []
    for (let i = 0; i < n; i++) {
      if (this.make(buf[i]!)) {
        this.unmake()
        out.push(buf[i]!)
      }
    }
    return out
  }

  /** The legal move written as `uci` (a queen promotion with or without "q"), or -1. */
  parseUci(uci: string): Move {
    if (uci.length < 4 || uci.length > 5) return -1
    const from = (uci.charCodeAt(1) - 49) * 8 + (uci.charCodeAt(0) - 97)
    const to = (uci.charCodeAt(3) - 49) * 8 + (uci.charCodeAt(2) - 97)
    const letter = uci.length === 5 ? uci[4]! : 'q'
    for (const m of this.legalMoves()) {
      if (moveFrom(m) !== from || moveTo(m) !== to) continue
      const p = movePromo(m)
      if (p === 0 || PROMO_LETTER[p] === letter) return m
    }
    return -1
  }

  /** True when neither side can ever mate: bare kings, or one minor piece. */
  insufficientMaterial(): boolean {
    let minors = 0
    for (let s = 0; s < 64; s++) {
      const c = this.sq[s]!
      if (c === 0) continue
      const t = typeOf(c)
      if (t === KING) continue
      if (t === KNIGHT || t === BISHOP) minors++
      else return false
    }
    return minors <= 1
  }

  /** Pieces other than pawns and kings for `side` (null-move safety). */
  hasPieces(side: number): boolean {
    for (let s = 0; s < 64; s++) {
      const c = this.sq[s]!
      if (c === 0 || colorOf(c) !== side) continue
      const t = typeOf(c)
      if (t >= KNIGHT && t <= QUEEN) return true
    }
    return false
  }
}
