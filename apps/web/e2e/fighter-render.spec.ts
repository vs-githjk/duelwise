import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// T33: the 2.5D fighter renderer, driven by the dev view (/dev/fighter-view) over a 20 second
// fixture replay (1200 sim frames, two scripted bots). Screenshots go to FIGHTER_SHOTS_DIR when set.

const ASSET_DIR = join(import.meta.dirname, '..', 'public', 'assets', 'fighter')
const BUDGET_BYTES = 15 * 1024 * 1024
const CHECKPOINTS = [150, 600, 1100]

interface ViewApi {
  ready: boolean
  done: boolean
  frame: number
  loadError: string | null
  unmappedMoves: number[]
  moveCount: number
  glErrors: string[]
  sample(): { width: number; height: number; litFraction: number; distinct: number }
  frameStats(): { count: number; p50: number; p95: number; max: number; renderP50: number; renderP95: number; renderer: string }
}

declare global {
  interface Window {
    __fighterView?: ViewApi
  }
}

function dirBytes(dir: string): number {
  let sum = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    sum += st.isDirectory() ? dirBytes(p) : st.size
  }
  return sum
}

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

test.describe('fighter renderer', () => {
  test('plays a 20 second fixture replay without errors, never blank, within budget', async ({ page }, testInfo) => {
    test.setTimeout(150_000)
    const errors = watchConsole(page)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/dev/fighter-view?capture=1')
    await page.waitForFunction(() => window.__fighterView?.ready === true || window.__fighterView?.loadError, undefined, { timeout: 90_000 })
    expect(await page.evaluate(() => window.__fighterView!.loadError)).toBeNull()

    // Every move id has a CC0 clip mapping.
    const mapping = await page.evaluate(() => ({ unmapped: window.__fighterView!.unmappedMoves, count: window.__fighterView!.moveCount }))
    expect(mapping.count).toBeGreaterThanOrEqual(31)
    expect(mapping.unmapped).toEqual([])

    const shots = process.env.FIGHTER_SHOTS_DIR
    if (shots) mkdirSync(shots, { recursive: true })
    for (const cp of CHECKPOINTS) {
      await page.waitForFunction((n) => (window.__fighterView?.frame ?? 0) >= n, cp, { timeout: 90_000 })
      const s = await page.evaluate(() => window.__fighterView!.sample())
      expect(s.width).toBeGreaterThan(0)
      // Not blank: a real scene lights most pixels and holds many distinct colours.
      expect(s.litFraction, `checkpoint ${cp} lit fraction`).toBeGreaterThan(0.2)
      expect(s.distinct, `checkpoint ${cp} distinct colours`).toBeGreaterThan(200)
      if (shots) await page.getByTestId('fighter-stage').screenshot({ path: join(shots, `fighter-f${cp}.png`) })
    }
    await page.waitForFunction(() => window.__fighterView?.done === true, undefined, { timeout: 90_000 })

    const stats = await page.evaluate(() => window.__fighterView!.frameStats())
    const gl = await page.evaluate(() => window.__fighterView!.glErrors)
    const line = `frame time over ${stats.count} frames (${stats.renderer}): rAF p50 ${stats.p50.toFixed(1)} ms, p95 ${stats.p95.toFixed(1)} ms, max ${stats.max.toFixed(1)} ms; render() p50 ${stats.renderP50.toFixed(2)} ms, p95 ${stats.renderP95.toFixed(2)} ms`
    console.log(line)
    testInfo.annotations.push({ type: 'frame-time', description: line })
    if (shots) writeFileSync(join(shots, 'frame-time.txt'), line + '\n')
    expect(stats.count).toBeGreaterThan(30)
    // Loose pathology guard only; the 60 fps budget is judged on real GPU hardware, not in headless software GL.
    expect(stats.renderP50).toBeLessThan(250)

    expect(gl).toEqual([])
    expect(errors).toEqual([])
    expect(dirBytes(ASSET_DIR)).toBeLessThan(BUDGET_BYTES)
  })
})
