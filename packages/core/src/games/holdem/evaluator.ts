// Seven-card (or five or six-card) hand evaluator. rank7 returns an integer where a larger
// value is a stronger hand and equal values tie. Layout: category in bits 20+, then up to
// five 4-bit rank nibbles, most significant first. Rank bitmasks per suit and two 8192-entry
// tables (straight high card, top five ranks) make it a few dozen integer ops per hand.

export const CATEGORY_NAMES = [
  'high card',
  'pair',
  'two pair',
  'three of a kind',
  'straight',
  'flush',
  'full house',
  'four of a kind',
  'straight flush',
] as const

const SIZE = 1 << 13
const POP = new Uint8Array(SIZE)
/** High card index (0..12) of the best straight in a rank mask, plus one; 0 when none. The wheel counts as high card 5 (index 3). */
const STRAIGHT = new Uint8Array(SIZE)
/** Up to the five highest ranks of a mask packed as nibbles, highest in bits 16..19. */
const TOP5 = new Int32Array(SIZE)

for (let m = 0; m < SIZE; m++) {
  let pop = 0
  let packed = 0
  let taken = 0
  for (let r = 12; r >= 0; r--) {
    if (m & (1 << r)) {
      pop++
      if (taken < 5) {
        packed |= r << (16 - 4 * taken)
        taken++
      }
    }
  }
  POP[m] = pop
  TOP5[m] = packed
  for (let h = 12; h >= 4; h--) {
    const run = 31 << (h - 4)
    if ((m & run) === run) {
      STRAIGHT[m] = h + 1
      break
    }
  }
  if (STRAIGHT[m] === 0 && (m & 0x100f) === 0x100f) STRAIGHT[m] = 4 // A 2 3 4 5
}

const msb = (x: number): number => 31 - Math.clz32(x)

export function rank7(cards: ArrayLike<number>): number {
  let s0 = 0
  let s1 = 0
  let s2 = 0
  let s3 = 0
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]!
    const bit = 1 << (c >> 2)
    const s = c & 3
    if (s === 0) s0 |= bit
    else if (s === 1) s1 |= bit
    else if (s === 2) s2 |= bit
    else s3 |= bit
  }
  const ones = s0 | s1 | s2 | s3
  const a01 = s0 & s1
  const a23 = s2 & s3
  const fours = a01 & a23
  const threes = (a01 & (s2 | s3)) | (a23 & (s0 | s1))
  const twos = a01 | a23 | ((s0 | s1) & (s2 | s3))

  let flush = 0
  if (POP[s0]! >= 5) flush = s0
  else if (POP[s1]! >= 5) flush = s1
  else if (POP[s2]! >= 5) flush = s2
  else if (POP[s3]! >= 5) flush = s3

  if (flush !== 0) {
    const sf = STRAIGHT[flush]!
    if (sf !== 0) return (8 << 20) | ((sf - 1) << 16)
  }
  if (fours !== 0) {
    const q = msb(fours)
    return (7 << 20) | (q << 16) | (msb(ones & ~(1 << q)) << 12)
  }
  if (threes !== 0) {
    const t = msb(threes)
    const rest = twos & ~(1 << t)
    if (rest !== 0) return (6 << 20) | (t << 16) | (msb(rest) << 12)
  }
  if (flush !== 0) return (5 << 20) | TOP5[flush]!
  const st = STRAIGHT[ones]!
  if (st !== 0) return (4 << 20) | ((st - 1) << 16)
  if (threes !== 0) {
    const t = msb(threes)
    return (3 << 20) | (t << 16) | ((TOP5[ones & ~(1 << t)]! >> 4) & 0xff00)
  }
  if (twos !== 0) {
    const p1 = msb(twos)
    const rest = twos & ~(1 << p1)
    if (rest !== 0) {
      const p2 = msb(rest)
      const kick = msb(ones & ~(1 << p1) & ~(1 << p2))
      return (2 << 20) | (p1 << 16) | (p2 << 12) | (kick << 8)
    }
    return (1 << 20) | (p1 << 16) | ((TOP5[ones & ~(1 << p1)]! >> 4) & 0xfff0)
  }
  return TOP5[ones]!
}

/** 0 (high card) to 8 (straight flush). */
export const handCategory = (score: number): number => score >> 20

export const handCategoryName = (score: number): string => CATEGORY_NAMES[score >> 20]!

/** Compares two hands given as card lists: positive when a wins, 0 on a split. */
export function compareHands(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return rank7(a) - rank7(b)
}
