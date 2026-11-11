// A sim state on the wire (slice 2, S7). The relay sends its confirmed state as JSON when a client's hash differs; the states hold
// typed arrays (the rng, counters), which JSON turns into objects, so they travel as plain arrays and are poured back into a
// state the client already owns (no allocation of a new shape, the same fields the sim reads).

/** A JSON-safe deep copy: typed arrays become arrays. */
export function toWire(s: unknown): unknown {
  if (ArrayBuffer.isView(s)) return Array.from(s as unknown as ArrayLike<number>)
  if (Array.isArray(s)) return s.map(toWire)
  if (s !== null && typeof s === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(s)) out[k] = toWire((s as Record<string, unknown>)[k])
    return out
  }
  return s
}

/** Pours a wire value into `dst`, field by field. Fields `dst` does not have are ignored; typed arrays keep their length. */
export function fromWire(dst: any, src: any): void {
  for (const k of Object.keys(dst)) {
    if (!(k in src)) continue
    const d = dst[k]
    const s = src[k]
    if (ArrayBuffer.isView(d)) {
      if (Array.isArray(s)) (d as any).set(s.length > (d as any).length ? s.slice(0, (d as any).length) : s)
    } else if (Array.isArray(d)) {
      if (!Array.isArray(s)) continue
      d.length = s.length
      for (let i = 0; i < s.length; i++) {
        if (d[i] !== null && typeof d[i] === 'object' && s[i] !== null && typeof s[i] === 'object') fromWire(d[i], s[i])
        else d[i] = s[i]
      }
    } else if (d !== null && typeof d === 'object' && s !== null && typeof s === 'object') fromWire(d, s)
    else dst[k] = s
  }
}
