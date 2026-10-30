import type { Rng } from './types'

// xoshiro128** (Blackman and Vigna, public domain) seeded by splitmix32.
// Sims draw randomness only from here, never Math.random, Date or performance.now.

function splitmix32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x9e3779b9) | 0
    let t = a ^ (a >>> 16)
    t = Math.imul(t, 0x21f0aaad)
    t = t ^ (t >>> 15)
    t = Math.imul(t, 0x735a2d97)
    return (t ^ (t >>> 15)) >>> 0
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0
}

function fromWords(s0: number, s1: number, s2: number, s3: number): Rng {
  let a = s0 >>> 0
  let b = s1 >>> 0
  let c = s2 >>> 0
  let d = s3 >>> 0
  const nextU32 = (): number => {
    const r = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0
    const t = b << 9
    c ^= a
    d ^= b
    b ^= c
    a ^= d
    c ^= t
    d = rotl(d, 11)
    a >>>= 0
    b >>>= 0
    c >>>= 0
    d >>>= 0
    return r
  }
  return {
    nextU32,
    float: () => nextU32() / 4294967296,
    int(n: number): number {
      if (!Number.isInteger(n) || n < 1 || n > 4294967296) throw new RangeError('Rng.int needs an integer in 1..2^32, got ' + n)
      if (n === 1) return 0
      // Rejection sampling: no modulo bias.
      const limit = 4294967296 - (4294967296 % n)
      let x = nextU32()
      while (x >= limit) x = nextU32()
      return x % n
    },
    state: () => new Uint32Array([a, b, c, d]),
  }
}

export function makeRng(seed: number): Rng {
  const sm = splitmix32(seed)
  return fromWords(sm(), sm(), sm(), sm())
}

/** Rebuilds a generator from `state()` so a stream can be saved and resumed. */
export function rngFromState(state: Uint32Array): Rng {
  if (state.length !== 4) throw new RangeError('Rng state must hold 4 words')
  if (state[0] === 0 && state[1] === 0 && state[2] === 0 && state[3] === 0) throw new RangeError('Rng state must not be all zero')
  return fromWords(state[0]!, state[1]!, state[2]!, state[3]!)
}
