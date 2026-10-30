// Where the chess model files live and how to read them: a fetch in the browser (the files are static
// assets next to the site), a file read under Bun or Node (the measurement harness runs the same code).

/** The model file is not published (yet): the level stays a preview. */
export class ModelMissingError extends Error {}

export const MODEL_BASE = '/agents/chess/v1'

export async function loadModelBytes(name: string, base: string = MODEL_BASE): Promise<Uint8Array> {
  if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node) {
    const { readFile } = await import('node:fs/promises')
    const path = new URL(`../../../../apps/web/public${base}/${name}`, import.meta.url)
    try {
      return new Uint8Array(await readFile(path))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ModelMissingError(`chess model ${name}: not found`)
      throw e
    }
  }
  const res = await fetch(`${base}/${name}`)
  if (res.status === 404) throw new ModelMissingError(`chess model ${name}: HTTP 404`)
  if (!res.ok) throw new Error(`chess model ${name}: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
