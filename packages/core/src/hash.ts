// FNV-1a 64 over a canonical encoding. Pure integer math on two 32-bit halves
// (no BigInt), so it is fast and identical in Bun, Node and browsers.

const OFFSET_HI = 0xcbf29ce4
const OFFSET_LO = 0x84222325
const PRIME_LO = 0x1b3 // prime is 2^40 + 0x1b3

function hex8(n: number): string {
  return n.toString(16).padStart(8, '0')
}

export function fnv1a64(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  let hi = OFFSET_HI
  let lo = OFFSET_LO
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]!) >>> 0
    const p = lo * PRIME_LO
    const carry = Math.floor(p / 4294967296)
    hi = (hi * PRIME_LO + carry + ((lo << 8) >>> 0)) >>> 0
    lo = p >>> 0
  }
  return hex8(hi) + hex8(lo)
}

/**
 * Canonical JSON: object keys sorted, undefined keys dropped, -0 as 0, typed arrays as
 * plain arrays. Non-finite numbers throw so a NaN can never be hashed silently.
 */
export function canonicalEncode(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalEncode: non-finite number')
      return Object.is(value, -0) ? '0' : String(value)
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'bigint':
      return value.toString()
    case 'object': {
      if (ArrayBuffer.isView(value)) {
        return canonicalEncode(Array.from(value as unknown as ArrayLike<number>))
      }
      if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalEncode(v))).join(',') + ']'
      const obj = value as Record<string, unknown>
      const parts: string[] = []
      for (const k of Object.keys(obj).sort()) {
        if (obj[k] === undefined) continue
        parts.push(JSON.stringify(k) + ':' + canonicalEncode(obj[k]))
      }
      return '{' + parts.join(',') + '}'
    }
    default:
      throw new Error('canonicalEncode: unsupported type ' + typeof value)
  }
}

export function hashState(value: unknown): string {
  return fnv1a64(canonicalEncode(value))
}
