import type { Level } from '@duelwise/core/src/product'
import type { Registry } from '../registry'

/** The preview network every level without a shipped, measured network plays (a Sable snapshot, to test the browser path). */
export const PREVIEW_MODEL = 'agents/puck/preview/policy.onnx'

const PUBLIC = 'apps/web/public/'

/**
 * The network a level plays, read from the registry and nothing else. A published level plays its own model. A level in training
 * plays the network its measurement used when the registry names one (Marlow is Vesper's network under Medium limits) and that file
 * is shipped; otherwise it plays the preview network. `measured` is true only when the played network is the one the registry's
 * numbers describe, so a card can quote a test result only for a level that really plays what was tested. Pip (Easy) is a script.
 */
export function playedModel(reg: Registry, level: Level): { path: string | null; measured: boolean } {
  const own = reg.levels[level]
  // Pip is a script whether or not it is published: an In training Pip must never fall back to the preview network.
  if (own?.config.scripted === true) return { path: null, measured: true }
  if (!own && reg.unpublishedConfig?.[level]?.scripted === true) return { path: null, measured: false }
  let name = typeof own?.config.model === 'string' ? own.config.model : null
  const network = reg.unpublishedConfig?.[level]?.network
  if (!own && typeof network === 'string') {
    const donor = Object.values(reg.levels).find((l) => l?.config.kind === network)
    if (typeof donor?.config.model === 'string') name = donor.config.model
  }
  const shipped = name === null ? undefined : reg.versions.map((v) => v.artifacts[name!]).find((a) => a !== undefined)
  if (shipped) return { path: shipped.startsWith(PUBLIC) ? shipped.slice(PUBLIC.length) : shipped, measured: true }
  return { path: PREVIEW_MODEL, measured: false }
}
