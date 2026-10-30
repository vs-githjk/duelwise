// Wire format between the Bun env host and Python (training/trainer/bridge.py).
// Frame: u32 LE total length (bytes after this field), u32 LE header length,
// JSON header (UTF-8), raw payload (the rest).

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export interface Frame {
  header: Record<string, any>
  payload: Uint8Array
}

export const DEFAULT_MAX_FRAME = 256 * 1024 * 1024

export function encodeFrame(header: Record<string, unknown>, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify(header))
  const total = 4 + h.length + payload.length
  const out = new Uint8Array(4 + total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, total, true)
  dv.setUint32(4, h.length, true)
  out.set(h, 8)
  out.set(payload, 8 + h.length)
  return out
}

/** Incremental reader: push chunks of any size, pull whole frames. */
export class FrameReader {
  private buf = new Uint8Array(0)

  constructor(private readonly maxFrame: number = DEFAULT_MAX_FRAME) {}

  push(chunk: Uint8Array): void {
    if (this.buf.length === 0) {
      this.buf = chunk.slice()
      return
    }
    const next = new Uint8Array(this.buf.length + chunk.length)
    next.set(this.buf, 0)
    next.set(chunk, this.buf.length)
    this.buf = next
  }

  next(): Frame | null {
    if (this.buf.length < 4) return null
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength)
    const total = dv.getUint32(0, true)
    if (total < 4 || total > this.maxFrame) throw new ProtocolError(`bad frame length ${total}`)
    if (this.buf.length < 4 + total) return null
    const headerLen = dv.getUint32(4, true)
    if (headerLen > total - 4) throw new ProtocolError(`header length ${headerLen} exceeds frame ${total}`)
    const frame = this.buf.subarray(4, 4 + total)
    this.buf = this.buf.slice(4 + total)
    let header: Record<string, any>
    try {
      header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4, 4 + headerLen)))
    } catch (e) {
      throw new ProtocolError(`header is not valid JSON: ${(e as Error).message}`)
    }
    if (header === null || typeof header !== 'object' || Array.isArray(header)) throw new ProtocolError('header must be a JSON object')
    return { header, payload: frame.slice(4 + headerLen) }
  }

  *drain(): Generator<Frame> {
    for (let f = this.next(); f; f = this.next()) yield f
  }
}
