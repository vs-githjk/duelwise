/**
 * The browser's copy of a registry file (A9): each level's `people` block keeps only what a level card needs, the band, the calibrated score
 * and the verdict. The full block (the test players' numbers and descriptions) stays in the file for the server and the tests. See vite.config.ts.
 */
export function trimRegistryPeople(json: string): string {
  const reg = JSON.parse(json) as { measured?: Record<string, { people?: { band: unknown; calibrated: number; verdict: string } }> }
  for (const m of Object.values(reg.measured ?? {})) {
    if (m.people) m.people = { band: m.people.band, calibrated: Math.round(m.people.calibrated * 1000) / 1000, verdict: m.people.verdict }
  }
  return JSON.stringify(reg)
}
