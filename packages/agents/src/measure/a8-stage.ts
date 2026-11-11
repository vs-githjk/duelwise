import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { writeJson } from './people-eval'

// A8: stages the realtime levels' retune for A9. Reads each level's final people measurement (the JSON the measure scripts wrote), pairs it with the
// published limits in LEVEL_LIMITS, and writes packages/agents/eval/people/<game>.json (the measurements) and <game>.staged.json (what A9 applies).
// Nothing here touches a published registry. Run from any directory with absolute paths:
//   bun packages/agents/src/measure/a8-stage.ts --spec <spec.json>
// spec: { game, rows: { <level>: { measurement: <abs json>, model?: <abs onnx>, source?: <repo-relative snapshot>, artifact?: <repo path> } } }

interface Spec {
  game: 'puck' | 'fighter' | 'arena'
  /** `stage: false` records the measurement only: the level's settings are not changing (A9 uses it for levels whose measurement describes what already ships). */
  rows: Record<string, { measurement: string; model?: string; source?: string; artifact?: string; limitsFrom?: 'level'; stage?: false }>
}

const argv = process.argv.slice(2)
const specPath = argv[argv.indexOf('--spec') + 1]
if (!specPath || !specPath.startsWith('/')) throw new Error('usage: a8-stage.ts --spec <absolute spec.json>')
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec
const root = resolve(import.meta.dir, '../../../..')
const measured: Record<string, unknown> = {}
const staged: Record<string, unknown> = {}
for (const [level, row] of Object.entries(spec.rows)) {
  if (!existsSync(row.measurement)) throw new Error(`missing measurement ${row.measurement}`)
  const m = JSON.parse(readFileSync(row.measurement, 'utf8')) as { estimate: { estimate: number; verdict: string; ci95: [number, number]; calibrated: number } }
  measured[level] = m
  if (row.stage === false) continue
  staged[level] = {
    limits: LEVEL_LIMITS[spec.game][level as 'easy'],
    ...(row.model ? { sha256: createHash('sha256').update(readFileSync(row.model)).digest('hex'), source: row.source, artifact: row.artifact } : {}),
    panel: m.estimate.estimate,
    ci95: m.estimate.ci95,
    calibrated: m.estimate.calibrated,
    verdict: m.estimate.verdict,
  }
}
writeJson(resolve(root, `packages/agents/eval/people/${spec.game}.json`), { game: spec.game, note: 'A8 final measurements per level; each file is the measure script output, recomputable from its own parts.', levels: measured })
writeJson(resolve(root, `packages/agents/eval/people/${spec.game}.staged.json`), staged)
console.log(JSON.stringify(staged, null, 1))
