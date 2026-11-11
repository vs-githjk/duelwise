import { z } from 'zod'
import { LEVELS } from './runtime/levels'

const LevelKey = z.enum(['easy', 'medium', 'hard', 'champion'])
const Iso = z.string().min(1)

/** Stormglass: the mean shots a level needs to sink a random fleet alone. A fleet is 17 cells, so a smaller mean is a score in the wrong place. */
export const MeanShotsSchema = z.object({
  mean: z.number().min(17).max(100),
  ci95: z.tuple([z.number(), z.number()]),
  n: z.number().int().positive(),
})

const Pair = z.tuple([z.number(), z.number()])
const ProxyScoreSchema = z.object({ value: z.number().min(0).max(1), ci95: Pair, n: z.number().int().nonnegative() })
const RealScoreSchema = z.object({
  n: z.number().int().positive(),
  players: z.number().int().positive(),
  value: z.number().min(0).max(1),
  ci95: Pair,
  asOf: z.string().min(1),
})
/** A1: the estimate of a level's score against ordinary players. Written by the measure scripts only. Rules for it: measure/people.ts. */
export const PeopleSchema = z.object({
  band: z.object({ low: z.number(), high: z.number() }),
  panel: z.object({ beginner: ProxyScoreSchema, average: ProxyScoreSchema, strong: ProxyScoreSchema }),
  estimate: z.number().min(0).max(1),
  ci95: Pair,
  real: RealScoreSchema.nullable(),
  calibrated: z.number().min(0).max(1),
  verdict: z.enum(['in-band', 'below', 'above', 'ceiling']),
  ceiling: z.object({ value: z.number(), ci95: Pair, by: z.string().min(1) }).optional(),
  /** Plain description of each test player: its hands, reaction and mistakes. */
  proxies: z.object({ beginner: z.string().min(1), average: z.string().min(1), strong: z.string().min(1) }),
})

/**
 * The part of a people block a browser needs to word a level card (the band, the calibrated score and the verdict). The build writes this form into
 * the browser's copy of each registry file (apps/web/vite.config.ts), so the verbose test-player numbers stay in the registry file and out of every
 * page's scripts; the server and the tests read the full block.
 */
export const PeopleCardSchema = z.object({
  band: z.object({ low: z.number(), high: z.number() }),
  calibrated: z.number().min(0).max(1),
  verdict: z.enum(['in-band', 'below', 'above', 'ceiling']),
})

export const MeasuredSchema = z.object({
  metric: z.string().min(1),
  value: z.number(),
  ci95: z.tuple([z.number(), z.number()]),
  n: z.number().int().nonnegative(),
  opponents: z.string().min(1),
  siteElo: z.number(),
  measuredAt: Iso,
  harness: z.enum(['bun', 'node', 'python']),
  commit: z.string().min(1),
  meanShots: MeanShotsSchema.optional(),
  /** Optional until A9, then required for every published level. */
  people: z.union([PeopleSchema, PeopleCardSchema]).optional(),
})

export const VersionSchema = z.object({
  version: z.string().min(1),
  parent: z.string().nullable(),
  createdAt: Iso,
  promotedAt: Iso.nullable(),
  status: z.enum(['preview', 'measured', 'candidate', 'retired']),
  artifacts: z.record(z.string(), z.string()),
  sha256: z.record(z.string(), z.string()),
  trainedSteps: z.number().int().nonnegative(),
  humanMatchesUsed: z.number().int().nonnegative(),
  gate: z.unknown().nullable(),
})

export const RegistrySchema = z.object({
  game: z.enum(['chess', 'four', 'holdem', 'word', 'fighter', 'arena', 'fleet', 'slack', 'penalty', 'puck']),
  champion: z.string().min(1),
  versions: z.array(VersionSchema).min(1),
  levels: z.partialRecord(LevelKey, z.object({ version: z.string().min(1), config: z.record(z.string(), z.unknown()) })),
  measured: z.partialRecord(LevelKey, MeasuredSchema),
  /** A level that failed its gate is not published; the reason is shown as "in training". */
  unpublished: z.partialRecord(LevelKey, z.string()).optional(),
  /** The config of a level that is in `unpublished`, kept so the level keeps it when a later ladder publishes it. */
  unpublishedConfig: z.partialRecord(LevelKey, z.record(z.string(), z.unknown())).optional(),
  learnsFromHumans: z.boolean(),
})

export type Measured = z.infer<typeof MeasuredSchema>
export type RegistryVersion = z.infer<typeof VersionSchema>
export type Registry = z.infer<typeof RegistrySchema>

export class RegistryError extends Error {
  readonly errors: string[]
  constructor(errors: string[]) {
    super('Invalid registry: ' + errors.join('; '))
    this.name = 'RegistryError'
    this.errors = errors
  }
}

export function validateRegistry(data: unknown): { ok: boolean; errors: string[] } {
  const shape = RegistrySchema.safeParse(data)
  if (!shape.success) return { ok: false, errors: shape.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) }
  const reg = shape.data
  const errors: string[] = []
  const versions = new Map(reg.versions.map((v) => [v.version, v]))
  if (versions.size !== reg.versions.length) errors.push('versions: duplicate version names')
  if (!versions.has(reg.champion)) errors.push(`champion: ${reg.champion} is not in versions`)
  for (const v of reg.versions) {
    if (v.parent !== null && !versions.has(v.parent)) errors.push(`versions.${v.version}.parent: ${v.parent} is not in versions`)
    for (const k of Object.keys(v.sha256)) if (!(k in v.artifacts)) errors.push(`versions.${v.version}.sha256.${k}: no artifact with that name`)
  }
  for (const level of LEVELS) {
    const entry = reg.levels[level]
    const block = reg.measured[level]
    if (!entry) {
      if (block) errors.push(`measured.${level}: level ${level} is not in levels`)
      continue
    }
    const version = versions.get(entry.version)
    if (!version) {
      errors.push(`levels.${level}.version: ${entry.version} is not in versions`)
      continue
    }
    if (version.status !== 'preview' && !block) errors.push(`levels.${level}: published level ${level} has no measured block`)
    if (reg.unpublished?.[level]) errors.push(`levels.${level}: ${level} is both published and listed in unpublished`)
  }
  for (const [level, m] of Object.entries(reg.measured)) {
    const [lo, hi] = m.ci95
    if (!(lo <= m.value && m.value <= hi)) errors.push(`measured.${level}: ci95 [${lo}, ${hi}] does not contain value ${m.value}`)
  }
  return { ok: errors.length === 0, errors }
}

export function parseRegistry(data: unknown): Registry {
  const v = validateRegistry(data)
  if (!v.ok) throw new RegistryError(v.errors)
  return RegistrySchema.parse(data)
}

/** Validates, then writes the file with stable key order and a trailing newline. Node or Bun only. */
export async function writeRegistry(path: string, reg: Registry): Promise<void> {
  const checked = parseRegistry(reg)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, JSON.stringify(checked, null, 2) + '\n', 'utf8')
}
