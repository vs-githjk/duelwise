// gzip for match records. The sync pair uses node:zlib (Bun, Node: server and tests);
// the async pair uses CompressionStream (browsers, Bun, Node) and is what the web
// recorder uses. Both produce standard gzip, so either side can read the other.

type Zlib = {
  gzipSync(b: Uint8Array): Uint8Array
  gunzipSync(b: Uint8Array, o?: { maxOutputLength?: number }): Uint8Array
}

function zlib(): Zlib {
  const g = globalThis as unknown as { process?: { getBuiltinModule?: (id: string) => unknown } }
  const z = g.process?.getBuiltinModule?.('node:zlib') as Zlib | undefined
  if (!z) throw new Error('sync gzip needs Node or Bun; use gzipAsync in the browser')
  return z
}

export function gzipSync(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(zlib().gzipSync(bytes))
}

/** Throws if the output would exceed maxOutputBytes (decompression bomb guard). */
export function gunzipSync(bytes: Uint8Array, maxOutputBytes: number): Uint8Array {
  return new Uint8Array(zlib().gunzipSync(bytes, { maxOutputLength: maxOutputBytes }))
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, maxOutputBytes: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter()
  const writing = writer.write(bytes as unknown as BufferSource).then(() => writer.close())
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxOutputBytes) {
        await reader.cancel()
        throw new Error('gzip output exceeds ' + maxOutputBytes + ' bytes')
      }
      chunks.push(value)
    }
    await writing
  } catch (e) {
    writing.catch(() => {})
    throw e
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

export function gzipAsync(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('gzip'), Number.MAX_SAFE_INTEGER)
}

export function gunzipAsync(bytes: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream('gzip'), maxOutputBytes)
}
