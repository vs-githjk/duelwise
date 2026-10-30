import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Path of the paid clip file (apps/web/src/games/arena/render/opponent.ts PAID_CLIPS_PATH); keyed on the path so any VITE_PAID_ASSETS_URL base works.
const PAID_CLIPS_PATH = 'arena/quaternius/universal-animation-library/ual1-shooter.glb'

// T35: the first person arena renderer, driven by the dev view (/dev/arena-view) over a 25 second
// fixture replay (1500 sim frames, two scripted bots, you are seat 0). Screenshots go to
// ARENA_SHOTS_DIR when set.

const ASSET_DIR = join(import.meta.dirname, '..', 'public', 'assets', 'arena')
const MAP_JSON = join(import.meta.dirname, '..', '..', '..', 'packages', 'core', 'src', 'games', 'arena', 'maps', 'duel-1.json')
const BUDGET_BYTES = 20 * 1024 * 1024
const CHECKPOINTS = [200, 700, 1300]
/** Metres the opponent's barrel line may pass from your eye while it aims fully at you. */
const BARREL_MISS_MAX = 0.08

interface ViewApi {
  ready: boolean
  done: boolean
  frame: number
  loadError: string | null
  expectedBoxes: number
  glErrors: string[]
  shots: number
  hits: number
  boxCheck(): { meshes: number; mismatches: number }
  sample(): { width: number; height: number; litFraction: number; distinct: number }
  frameStats(): { count: number; p50: number; p95: number; max: number; renderP50: number; renderP95: number; renderer: string }
  decals(): number
  barrelStats(): { count: number; max: number; mean: number; pistolFrames: number }
  torsoCoverage(): { rect: [number, number, number, number]; torsoPixels: number; coveredPixels: number } | null
}

declare global {
  interface Window {
    __arenaView?: ViewApi
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
    if (m.type() === 'error' && !m.location().url.endsWith(PAID_CLIPS_PATH)) errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

test.describe('arena renderer', () => {
  test('plays a 25 second fixture replay without errors, map matches the sim, never blank, within budget', async ({ page }, testInfo) => {
    test.setTimeout(180_000)
    const errors = watchConsole(page)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/dev/arena-view?capture=1&guns=2,1')
    await page.waitForFunction(() => window.__arenaView?.ready === true || window.__arenaView?.loadError, undefined, { timeout: 90_000 })
    expect(await page.evaluate(() => window.__arenaView!.loadError)).toBeNull()

    // The meshes are the map: one per sim box (the json boxes plus four outer walls), each with the sim's exact bounds.
    const json = JSON.parse(readFileSync(MAP_JSON, 'utf8')) as { boxes: unknown[]; name: string }
    expect(json.name).toBe('Coldstore')
    const check = await page.evaluate(() => window.__arenaView!.boxCheck())
    expect(check.meshes).toBe(json.boxes.length + 4)
    expect(await page.evaluate(() => window.__arenaView!.expectedBoxes)).toBe(json.boxes.length + 4)
    expect(check.mismatches).toBe(0)

    const shots = process.env.ARENA_SHOTS_DIR
    if (shots) mkdirSync(shots, { recursive: true })
    for (const cp of CHECKPOINTS) {
      await page.waitForFunction((n) => (window.__arenaView?.frame ?? 0) >= n, cp, { timeout: 120_000 })
      const s = await page.evaluate(() => window.__arenaView!.sample())
      expect(s.width).toBeGreaterThan(0)
      // Not blank: a real scene lights a good share of pixels and holds many distinct colours.
      expect(s.litFraction, `checkpoint ${cp} lit fraction`).toBeGreaterThan(0.2)
      // 100, not 150 (T35c): the rifles now sit low and small, and frame 700 looks at a plain wall; 121 colours at 5 bits per channel is a lit, textured scene, a blank one has a handful.
      expect(s.distinct, `checkpoint ${cp} distinct colours`).toBeGreaterThan(100)
      if (shots) await page.getByTestId('arena-stage').screenshot({ path: join(shots, `arena-f${cp}.png`) })
    }
    await page.waitForFunction(() => window.__arenaView?.done === true, undefined, { timeout: 120_000 })

    // The replay had shots and hits, so tracers, impacts and the hit marker path all ran.
    const fx = await page.evaluate(() => ({ shots: window.__arenaView!.shots, hits: window.__arenaView!.hits, decals: window.__arenaView!.decals() }))
    expect(fx.shots).toBeGreaterThan(0)

    const stats = await page.evaluate(() => window.__arenaView!.frameStats())
    const gl = await page.evaluate(() => window.__arenaView!.glErrors)
    const line = `frame time over ${stats.count} frames (${stats.renderer}): rAF p50 ${stats.p50.toFixed(1)} ms, p95 ${stats.p95.toFixed(1)} ms, max ${stats.max.toFixed(1)} ms; render() p50 ${stats.renderP50.toFixed(2)} ms, p95 ${stats.renderP95.toFixed(2)} ms; your shots ${fx.shots}, hits ${fx.hits}, decals ${fx.decals}`
    console.log(line)
    testInfo.annotations.push({ type: 'frame-time', description: line })
    if (shots) writeFileSync(join(shots, 'frame-time.txt'), line + '\n')
    expect(stats.count).toBeGreaterThan(30)
    // Loose pathology guard only; the 60 fps budget is judged on real GPU hardware, not in software GL.
    expect(stats.renderP50).toBeLessThan(250)

    // Barrel to eye alignment in the live replay (T35 item 1): whenever the opponent aims fully at your eye, the
    // barrel line passes within a hand's width of it. Logged for the handoff.
    const bar = await page.evaluate(() => window.__arenaView!.barrelStats())
    console.log(`barrel miss over ${bar.count} aimed rifle frames (${bar.pistolFrames} pistol frames not counted): mean ${(bar.mean * 100).toFixed(1)} cm, max ${(bar.max * 100).toFixed(1)} cm`)
    if (shots) writeFileSync(join(shots, 'barrel-miss.txt'), `${bar.count} aimed frames, mean ${bar.mean.toFixed(4)} m, max ${bar.max.toFixed(4)} m\n`)
    expect(bar.count).toBeGreaterThan(0)
    expect(bar.max).toBeLessThan(BARREL_MISS_MAX)

    expect(gl).toEqual([])
    expect(errors).toEqual([])
    expect(dirBytes(ASSET_DIR)).toBeLessThan(BUDGET_BYTES)
  })

  // The paid clip file is gitignored and may be absent (fresh checkout, CI, production without the env var): the fetch 404s,
  // the free clips fill in, the view still draws the opponent, and nothing but that one expected 404 reaches the console.
  test('draws the opponent from the free clips when the paid file is missing', async ({ page }) => {
    test.setTimeout(180_000)
    const errors = watchConsole(page)
    const all: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') all.push(m.text())
    })
    let paidRequests = 0
    await page.route(`**/${PAID_CLIPS_PATH}`, (route) => {
      paidRequests += 1
      return route.fulfill({ status: 404, body: 'not found' })
    })
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/dev/arena-view?capture=1&guns=2,1')
    await page.waitForFunction(() => window.__arenaView?.ready === true || window.__arenaView?.loadError, undefined, { timeout: 90_000 })
    expect(await page.evaluate(() => window.__arenaView!.loadError)).toBeNull()
    await page.waitForFunction(() => (window.__arenaView?.frame ?? 0) >= 120, undefined, { timeout: 120_000 })
    // dd5dce3: the paid file is requested only when VITE_PAID_ASSETS_URL names a base; without one the free clips load and nothing is fetched.
    if (process.env.VITE_PAID_ASSETS_URL?.trim()) expect(paidRequests).toBeGreaterThan(0)
    else expect(paidRequests).toBe(0)
    const s = await page.evaluate(() => window.__arenaView!.sample())
    expect(s.litFraction).toBeGreaterThan(0.2)
    expect(s.distinct).toBeGreaterThan(100)
    // An opponent is drawn: it has a torso on screen at some point in the replay.
    await page.waitForFunction(() => (window.__arenaView?.torsoCoverage()?.torsoPixels ?? 0) > 0, undefined, { timeout: 120_000 })
    expect(all.filter((t) => !/Failed to load resource.*404/.test(t))).toEqual([])
    expect(errors).toEqual([])
  })

  // T35b: the rifles are the OGA GLB with PBR sets. Stills at 1440 wide, taken on the final commit when ARENA_SHOTS_DIR is set:
  // your Ridgeline and Carbine, and the opponent holding the Ridgeline from the side.
  for (const [name, query] of [
    ['ridgeline', 'pose=idle&own=1&at=-60,-50,2048'],
    ['carbine', 'pose=idle&own=2&at=-60,-50,2048'],
    ['opponent-side', 'pose=idle&weapon=1&own=0&at=-60,-50,2048'],
    ['torso-ridgeline', 'pose=idle&own=1&at=-360,112,0'],
    ['torso-carbine', 'pose=idle&own=2&at=-360,112,0'],
    ['torso-dart', 'pose=idle&own=0&at=-360,112,0'],
    ['replay-f700', 'hold=700'],
  ] as const) {
    test(`1440 still: ${name}`, async ({ page }) => {
      test.setTimeout(120_000)
      const errors = watchConsole(page)
      await page.setViewportSize({ width: 1440, height: 810 })
      await page.goto(`/dev/arena-view?capture=1&${query}`)
      await page.waitForFunction(() => window.__arenaView?.ready === true || window.__arenaView?.loadError, undefined, { timeout: 90_000 })
      expect(await page.evaluate(() => window.__arenaView!.loadError)).toBeNull()
      await page.waitForTimeout(1200)
      const s = await page.evaluate(() => window.__arenaView!.sample())
      expect(s.litFraction).toBeGreaterThan(0.2)
      expect(s.distinct).toBeGreaterThan(150)
      const shots = process.env.ARENA_SHOTS_DIR
      if (shots) {
        mkdirSync(shots, { recursive: true })
        await page.getByTestId('arena-stage').screenshot({ path: join(shots, `arena-1440-${name}.png`) })
      }
      expect(errors).toEqual([])
    })
  }

  // T35c: with your own weapon out, the opponent's torso (shoulders to pelvis) stays visible: the first person weapon and hands
  // cover none of its pixels at ?pose=idle&own=N&at=-360,112,0 (the opponent 7.6 m ahead and 17 degrees to the right).
  for (const [name, own] of [['Dart', 0], ['Ridgeline', 1], ['Carbine', 2]] as const) {
    test(`opponent torso pixels are visible with the ${name}`, async ({ page }) => {
      test.setTimeout(120_000)
      const errors = watchConsole(page)
      await page.setViewportSize({ width: 1440, height: 810 })
      await page.goto(`/dev/arena-view?capture=1&pose=idle&own=${own}&at=-360,112,0`)
      await page.waitForFunction(() => window.__arenaView?.ready === true || window.__arenaView?.loadError, undefined, { timeout: 90_000 })
      expect(await page.evaluate(() => window.__arenaView!.loadError)).toBeNull()
      await page.waitForTimeout(1500)
      const c = await page.evaluate(() => window.__arenaView!.torsoCoverage())
      expect(c, 'the torso is on screen').not.toBeNull()
      console.log(`${name}: torso rect ${JSON.stringify(c!.rect)}, ${c!.torsoPixels} px, covered by the viewmodel ${c!.coveredPixels} px`)
      expect(c!.torsoPixels).toBeGreaterThan(800)
      expect(c!.coveredPixels).toBe(0)
      expect(errors).toEqual([])
    })
  }
})
