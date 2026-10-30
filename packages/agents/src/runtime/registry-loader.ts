import type { GameId } from '@duelwise/core/src/product'
import { parseRegistry, type Registry } from '../registry'
import type { Level } from '@duelwise/core/src/product'

export type RegistrySource = (game: GameId) => Promise<unknown | null>

/**
 * Default source. In the browser the registry is a static file next to the models
 * (`/agents/<game>/registry.json`); under Bun or Node it is read from packages/agents/registry.
 * A missing file means the game has no registry yet and the agent shows "preview".
 */
export const defaultSource: RegistrySource = async (game) => {
  if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node) {
    const { readFile } = await import('node:fs/promises')
    try {
      const url = new URL(`../../registry/${game}.json`, import.meta.url)
      return JSON.parse(await readFile(url, 'utf8'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }
  const res = await fetch(`/agents/${game}/registry.json`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`registry for ${game}: HTTP ${res.status}`)
  return res.json()
}

export async function loadRegistry(game: GameId, source: RegistrySource = defaultSource): Promise<Registry | null> {
  const raw = await source(game)
  if (raw === null) return null
  const reg = parseRegistry(raw)
  if (reg.game !== game) throw new Error(`registry file for ${game} says game ${reg.game}`)
  return reg
}

/** A level is playable as a measured level when its registry version is not a preview. Otherwise the UI shows "preview". */
export function levelStatus(reg: Registry | null, level: Level): { preview: boolean; version: string | null } {
  const entry = reg?.levels[level]
  if (!reg || !entry) return { preview: true, version: null }
  const version = reg.versions.find((v) => v.version === entry.version)
  return { preview: !version || version.status === 'preview' || !reg.measured[level], version: entry.version }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function verifySha256(bytes: Uint8Array, expectedHex: string): Promise<boolean> {
  return (await sha256Hex(bytes)) === expectedHex.toLowerCase()
}
