import { mkdirSync } from 'node:fs'
import { expect, test, type CDPSession, type Page } from '@playwright/test'

/**
 * Realtime friend games on one device (slice 2). Glasscut: two people, two thumbs, one phone. Nothing is rated or saved, so no request
 * may reach a server function or the match endpoints once the friend game is chosen. FRIENDS_SHOTS=<dir> saves the screenshots.
 * window.__friendPuck is typed by apps/web/src/games/friends/useLocalPuck.ts.
 */
const SHOTS = process.env.FRIENDS_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  const benign = /Failed to load resource|\[vite\] Internal Server Error[\s\S]*aborted/
  page.on('console', (m) => {
    if (m.type() === 'error' && !benign.test(m.text())) errors.push(`console: ${m.text()}`)
  })
  return errors
}

/** Every request from now on that reaches a server function or an /api endpoint. */
function watchServer(page: Page): string[] {
  const hits: string[] = []
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname
    if (/^\/(_serverFn\/|api\/)/.test(p) && p !== '/api/ping') hits.push(`${r.method()} ${p}`)
  })
  return hits
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

async function chooseFriend(page: Page, query: string, names: [string, string]) {
  await page.goto(`/play/glasscut${query}`)
  await page.locator('[data-opponent-option="friend"]').click()
  await expect(page.getByTestId('friend-setup')).toBeVisible()
  await page.getByLabel('Player one').fill(names[0])
  await page.getByLabel('Player two').fill(names[1])
  await page.locator('[data-side-option="one"]').click()
}

type Dbg = { ready: boolean; frame: number; over: boolean; score: [number, number]; mallets: [[number, number], [number, number]]; puck: [number, number]; offset: number; toScreen: [number, number] }
const readDbg = (page: Page) =>
  page.evaluate(() => {
    const d = window.__friendPuck!
    return { ready: d.ready, frame: d.frame, over: d.over, score: d.score, mallets: d.mallets, puck: d.puck, offset: d.offset }
  })
const toScreen = (page: Page, wx: number, wy: number) => page.evaluate(([x, y]) => window.__friendPuck!.toScreen(x!, y!), [wx, wy] as const)

/** Two fingers on one screen through the DevTools protocol, so the page sees two touch pointers at once. */
class Fingers {
  private pts = new Map<number, { x: number; y: number }>()
  constructor(private cdp: CDPSession) {}
  private send(type: 'touchStart' | 'touchMove' | 'touchEnd') {
    const touchPoints = [...this.pts.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id }))
    return this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints })
  }
  async down(id: number, x: number, y: number) {
    this.pts.set(id, { x, y })
    await this.send('touchStart')
  }
  async move(id: number, x: number, y: number) {
    this.pts.set(id, { x, y })
    await this.send('touchMove')
  }
  /** A touchEnd lists the fingers that stay down, so the lifted one is dropped from the list first. */
  async up(id: number) {
    this.pts.delete(id)
    await this.send('touchEnd')
  }
}

test.describe('Glasscut with a friend on one phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test.setTimeout(150_000)
  test.skip(({ browserName }) => browserName !== 'chromium', 'DevTools touch events are Chromium only; WebKit checks the layout below')

  const playTo = async (page: Page, winner: 0 | 1, full: boolean) => {
    const errors = watchConsole(page)
    await chooseFriend(page, '?seed=7&lead=6', ['Alex', 'Sam'])
    if (full) await shot(page, 'glasscut-friend-setup-390')
    const server = watchServer(page)
    await page.getByTestId('friend-start').click()
    await page.waitForFunction(() => window.__friendPuck?.ready === true)
    await expect(page.getByTestId('fp-chip-0')).toContainText('Alex')
    await expect(page.getByTestId('fp-chip-1')).toContainText('Sam')
    await expect(page.getByTestId('fp-hint')).toContainText('One thumb each')
    // The table fits: the canvas is the whole stage and nothing scrolls.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    const cdp = await page.context().newCDPSession(page)
    const fingers = new Fingers(cdp)
    const d0 = await readDbg(page)
    const off = d0.offset
    // Fingers land on the halves: the bottom thumb behind its mallet, the top thumb behind its own.
    const [b0x, b0y] = await toScreen(page, 0.5, 0.3)
    const [t0x, t0y] = await toScreen(page, 0.5, 1.7)
    await fingers.down(1, b0x!, b0y! + off)
    await fingers.down(2, t0x!, t0y! - off)

    // Both ends start at 6-6, so the next goal wins. Only the winning end attacks: it lines up behind a puck in its half, then charges
    // through it at the far goal. The other end keeps its mallet to the side.
    const deadline = Date.now() + 100_000
    const latch = [false, false]
    let shotDone = false
    const brain = (own: { px: number; py: number; mx: number; my: number }, seat: 0 | 1, attack: boolean): [number, number] => {
      const { px, py, mx, my } = own
      // Not its turn: stay aside. Its turn but the puck is far away or close to its own goal: guard the goal (a rebound from the far wall
      // must not slip in behind a charge), and never charge from there (a charge could score against itself).
      if (!attack) {
        latch[seat] = false
        return [0.15, 0.25]
      }
      if (py >= 1 || py < 0.45 || Math.abs(px - 0.5) > 0.15) {
        latch[seat] = false
        return [Math.min(0.8, Math.max(0.2, px)), 0.15]
      }
      if (latch[seat]) {
        if (my > py + 0.12) {
          latch[seat] = false
          return [Math.min(0.8, Math.max(0.2, px)), 0.15]
        }
        return [px, Math.min(py + 0.15, 0.93)]
      }
      if (Math.abs(mx - px) < 0.025 && my < py - 0.1) {
        latch[seat] = true
        return [px, Math.min(py + 0.15, 0.93)]
      }
      return [px, Math.max(0.12, py - 0.2)]
    }
    while (Date.now() < deadline) {
      const d = await readDbg(page)
      if (d.over) break
      const [px, py] = d.puck
      const [m0x, m0y] = d.mallets[0]
      const [m1x, m1y] = d.mallets[1]
      const a0 = winner === 0
      const a1 = winner === 1
      const b = brain({ px, py, mx: m0x, my: m0y }, 0, a0)
      const t = brain({ px: 1 - px, py: 2 - py, mx: 1 - m1x, my: 2 - m1y }, 1, a1)
      if (full && !shotDone && d.frame > 90) {
        await shot(page, 'glasscut-friend-play-390')
        shotDone = true
      }
      const [bx, by] = await toScreen(page, b[0], b[1])
      const [tx, ty] = await toScreen(page, 1 - t[0], 2 - t[1])
      await fingers.move(1, bx!, by! + off)
      await fingers.move(2, tx!, ty! - off)
      await page.waitForTimeout(20)
    }
    const end = await readDbg(page)
    expect(end.over).toBe(true)
    expect(end.score, JSON.stringify(end)).toEqual(winner === 0 ? [7, 6] : [6, 7])
    await fingers.up(1)
    await fingers.up(2)

    await expect(page.getByTestId('friend-result')).toBeVisible()
    await expect(page.getByTestId('friend-result-title')).toContainText(winner === 0 ? 'Alex' : 'Sam')
    await expect(page.getByTestId('friend-rematch')).toHaveText('Rematch, swap sides')
    await expect(page.getByTestId('friend-not-rated')).toBeVisible()
    expect(server).toEqual([])
    if (!full) {
      expect(errors).toEqual([])
      return
    }
    await page.waitForTimeout(1000)
    await shot(page, 'glasscut-friend-result-390')

    // The rematch swaps ends and starts level.
    await page.getByTestId('friend-rematch').click()
    await page.waitForFunction(() => window.__friendPuck?.ready === true && window.__friendPuck.frame < 30)
    await expect(page.getByTestId('fp-chip-0')).toContainText('Sam')
    await expect(page.getByTestId('fp-chip-1')).toContainText('Alex')
    await expect(page.getByTestId('fp-score-0')).toHaveText('0')
    expect(server).toEqual([])
    expect(errors).toEqual([])
  }

  test('two thumbs play to a result: the bottom end attacks and wins, no request reaches the server, the rematch swaps ends', async ({ page }) => {
    await playTo(page, 0, true)
  })

  test('two thumbs play to a result: the top end attacks and wins', async ({ page }) => {
    await playTo(page, 1, false)
  })

  test('a finger on the centre line steers nothing, and the third finger is ignored', async ({ page }) => {
    await chooseFriend(page, '?seed=11', ['Alex', 'Sam'])
    await page.getByTestId('friend-start').click()
    await page.waitForFunction(() => window.__friendPuck?.ready === true)
    const cdp = await page.context().newCDPSession(page)
    const fingers = new Fingers(cdp)
    const [, cy] = await toScreen(page, 0.5, 1)
    const [bx, by] = await toScreen(page, 0.85, 0.3)
    const before = await readDbg(page)
    await fingers.down(5, bx!, cy! + 4)
    await fingers.move(5, bx! - 120, cy! + 4)
    await page.waitForTimeout(400)
    const centre = await readDbg(page)
    expect(centre.mallets[0][0]).toBeCloseTo(before.mallets[0][0], 1)
    await fingers.up(5)
    // A real finger in the bottom half moves seat 0 only.
    await fingers.down(1, bx!, by! + 30)
    await page.waitForTimeout(500)
    const moved = await readDbg(page)
    expect(moved.mallets[0][0]).toBeGreaterThan(0.6)
    expect(moved.mallets[1][0]).toBeCloseTo(before.mallets[1][0], 1)
    // A second finger in the same half and a finger at the top that is then lifted leave seat 0 alone.
    const [sx, sy] = await toScreen(page, 0.1, 0.4)
    await fingers.down(2, sx!, sy! + 30)
    await page.waitForTimeout(300)
    expect((await readDbg(page)).mallets[0][0]).toBeGreaterThan(0.6)
    await fingers.up(2)
    await fingers.up(1)
  })
})

test.describe('Glasscut with a friend: layout on every engine', () => {
  for (const vp of [{ w: 360, h: 780 }, { w: 390, h: 844 }, { w: 1440, h: 900 }]) {
    test(`the table and both score rows fit at ${vp.w}x${vp.h}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h })
      const errors = watchConsole(page)
      await chooseFriend(page, '?seed=5', ['Alex', 'Sam'])
      await page.getByTestId('friend-start').click()
      await page.waitForFunction(() => window.__friendPuck?.ready === true)
      const box = async (id: string) => (await page.getByTestId(id).boundingBox())!
      const [top, bottom, back, pause, canvas] = [await box('fp-chip-1'), await box('fp-chip-0'), await box('puck-back'), await box('puck-pause'), await box('puck-canvas')]
      // Everything is on screen, and the two score rows never touch the table or each other.
      for (const b of [top, bottom, back, pause]) {
        expect(b.x).toBeGreaterThanOrEqual(0)
        expect(b.x + b.width).toBeLessThanOrEqual(vp.w)
        expect(b.y).toBeGreaterThanOrEqual(0)
        expect(b.y + b.height).toBeLessThanOrEqual(vp.h)
      }
      const [x0, y0] = await toScreen(page, 0, 2)
      const [x1, y1] = await toScreen(page, 1, 0)
      expect(top.y + top.height).toBeLessThanOrEqual(y0! + 2)
      expect(bottom.y).toBeGreaterThanOrEqual(y1! - 2)
      expect(x1! - x0!).toBeGreaterThan(Math.min(vp.w, vp.h / 2) * 0.8 - 60)
      expect(canvas.width).toBe(vp.w)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(errors).toEqual([])
    })
  }
})

test.describe('Glasscut with a friend on a computer', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test.skip(({ browserName, hasTouch }) => browserName !== 'chromium' || hasTouch, 'a mouse and the arrow keys need a computer; the WebKit project is an iPhone')
  test('the mouse steers the bottom end, the arrow keys the top end, and the page says it is best on a phone', async ({ page }) => {
    const errors = watchConsole(page)
    await chooseFriend(page, '?seed=3', ['Alex', 'Sam'])
    await expect(page.getByTestId('friend-device-note')).toContainText('Best on one phone or tablet')
    await shot(page, 'glasscut-friend-setup-1440')
    const server = watchServer(page)
    await page.getByTestId('friend-start').click()
    await page.waitForFunction(() => window.__friendPuck?.ready === true)
    await expect(page.getByTestId('fp-hint')).toContainText('Bottom: mouse')
    const before = await readDbg(page)
    const [tx, ty] = await toScreen(page, 0.85, 0.45)
    await page.mouse.move(tx!, ty!)
    await page.mouse.move(tx! + 1, ty! + 1)
    await page.keyboard.down('ArrowLeft')
    await page.waitForTimeout(500)
    const after = await readDbg(page)
    expect(after.mallets[0][0]).toBeGreaterThan(0.7)
    // Screen left is the top player's right: the top mallet moves toward lower world x.
    expect(after.mallets[1][0]).toBeLessThan(before.mallets[1][0] - 0.1)
    await shot(page, 'glasscut-friend-play-1440')
    // The window loses focus with the arrow still down (no key-up arrives). After resuming, the top mallet must not keep drifting.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(page.getByTestId('puck-paused')).toBeVisible()
    await page.getByTestId('puck-resume').click()
    const resumed = await readDbg(page)
    await page.waitForTimeout(500)
    const later = await readDbg(page)
    expect(later.mallets[1][0]).toBeCloseTo(resumed.mallets[1][0], 1)
    // The mallet was pinned at the wall, so that check alone could pass without the fix. Move it off the wall, let go, and it must stay put.
    await page.keyboard.down('ArrowRight')
    await page.waitForTimeout(200)
    await page.keyboard.up('ArrowRight')
    const moved = await readDbg(page)
    await page.waitForTimeout(500)
    const settled = await readDbg(page)
    expect(moved.mallets[1][0]).toBeGreaterThan(resumed.mallets[1][0] + 0.1)
    expect(settled.mallets[1][0]).toBeCloseTo(moved.mallets[1][0], 1)
    await page.keyboard.up('ArrowLeft')
    expect(server).toEqual([])
    expect(errors).toEqual([])
  })
})

/**
 * Tinderbox for two people on one device. window.__friendFighter is typed by apps/web/src/games/friends/useLocalFighter.ts.
 * `hp` (with a fixed seed) starts both fighters on little health, so a round ends in seconds.
 */
async function chooseFighterFriend(page: Page, query: string, names: [string, string]) {
  await page.goto(`/play/tinderbox${query}`)
  await page.locator('[data-opponent-option="friend"]').click()
  await expect(page.getByTestId('friend-setup')).toBeVisible()
  await page.getByLabel('Player one').fill(names[0])
  await page.getByLabel('Player two').fill(names[1])
  await page.locator('[data-side-option="one"]').click()
}
const readFighter = (page: Page) => page.evaluate(() => ({ ...window.__friendFighter! }))

test.describe('Tinderbox with a friend on a computer', () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  test.setTimeout(150_000)
  test.skip(({ browserName, hasTouch }) => browserName !== 'chromium' || hasTouch, 'two keyboards need a computer; the WebKit project is an iPhone')

  test('two players on one keyboard fight to a KO: each map drives its own fighter, nothing reaches a server, the rematch swaps sides', async ({ page }) => {
    const errors = watchConsole(page)
    await chooseFighterFriend(page, '?seed=7&hp=60&speed=4', ['Alex', 'Sam'])
    await expect(page.getByTestId('friend-device-note')).toContainText('W A S D')
    await expect(page.getByTestId('friend-device-note')).toContainText('Arrow keys')
    await shot(page, 'tinderbox-friend-setup-1440')
    const server = watchServer(page)
    await page.getByTestId('friend-start').click()
    await page.waitForFunction(() => window.__friendFighter?.ready === true)
    await expect(page.getByTestId('hp-you')).toContainText('Alex')
    await expect(page.getByTestId('hp-ai')).toContainText('Sam')
    await expect(page.getByTestId('ff-keys')).toContainText('F G H')
    // The fight starts after the intro. Each map moves only its own fighter: D walks player one right, the left arrow walks player two left.
    // Wait for the fight itself (phase 1), then count frames, not milliseconds: the sim runs at 4x here, so a wall-clock wait is a guess.
    await page.waitForFunction(() => window.__friendFighter!.phase === 1 && window.__friendFighter!.frame > 60)
    const before = await readFighter(page)
    expect(before.phase).toBe(1)
    await page.keyboard.down('KeyD')
    await page.keyboard.down('ArrowLeft')
    await page.waitForFunction((f) => window.__friendFighter!.frame > f + 12, before.frame)
    const mid = await readFighter(page)
    await page.keyboard.up('ArrowLeft')
    await page.waitForFunction((f) => window.__friendFighter!.frame > f + 12, mid.frame)
    const after = await readFighter(page)
    // Both keys were held: the fighters close in (player one's x grew, player two's x shrank), and each seat got its own input word.
    expect(mid.input[0]).not.toBe(0)
    expect(mid.input[1]).not.toBe(0)
    expect(mid.input[0]).not.toBe(mid.input[1])
    expect(mid.x[0]).toBeGreaterThan(before.x[0])
    expect(mid.x[1]).toBeLessThan(before.x[1])
    // Player two let go: their fighter stops walking left (player one's walk may still push them).
    expect(after.input[1]).toBe(0)
    await shot(page, 'tinderbox-friend-play-1440')
    // Player one keeps walking and pressing light (F); player two stands still. Player one takes the rounds.
    const deadline = Date.now() + 100_000
    while (Date.now() < deadline) {
      const d = await readFighter(page)
      if (d.over) break
      await page.keyboard.press('KeyF')
      await page.waitForTimeout(60)
    }
    await page.keyboard.up('KeyD')
    expect((await readFighter(page)).over).toBe(true)
    await expect(page.getByTestId('friend-result')).toBeVisible()
    await expect(page.getByTestId('friend-result-title')).toContainText('Alex')
    await expect(page.getByTestId('friend-rematch')).toHaveText('Rematch, swap sides')
    await expect(page.getByTestId('friend-not-rated')).toBeVisible()
    await shot(page, 'tinderbox-friend-result-1440')
    expect(server).toEqual([])
    // The rematch swaps sides: Sam starts on the left.
    await page.getByTestId('friend-rematch').click()
    await page.waitForFunction(() => window.__friendFighter?.ready === true && window.__friendFighter.frame < 30)
    await expect(page.getByTestId('hp-you')).toContainText('Sam')
    await expect(page.getByTestId('hp-ai')).toContainText('Alex')
    expect(server).toEqual([])
    expect(errors).toEqual([])
  })

  test('Escape pauses both players, shows both key lists, and the match can be left with nothing saved', async ({ page }) => {
    await chooseFighterFriend(page, '?seed=9', ['Alex', 'Sam'])
    const server = watchServer(page)
    await page.getByTestId('friend-start').click()
    await page.waitForFunction(() => window.__friendFighter?.ready === true)
    await page.waitForFunction(() => window.__friendFighter!.frame > 30)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('ff-paused')).toBeVisible()
    await expect(page.getByTestId('ff-paused')).toContainText('Arrow keys to move')
    const frozen = (await readFighter(page)).frame
    await page.waitForTimeout(400)
    expect((await readFighter(page)).frame).toBe(frozen)
    // P pauses and resumes too (it is player two's pause key).
    await page.keyboard.press('KeyP')
    await expect(page.getByTestId('ff-paused')).toBeHidden()
    await page.keyboard.press('KeyP')
    await expect(page.getByTestId('ff-paused')).toBeVisible()
    await page.getByTestId('ff-leave').click()
    await expect(page.getByTestId('friend-setup')).toBeVisible()
    expect(server).toEqual([])
  })

  test('a fake gamepad moves a fighter and Start pauses', async ({ page }) => {
    await page.addInitScript(() => {
      const pad = { index: 0, id: 'fake', connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }
      ;(window as unknown as { __pad: typeof pad }).__pad = pad
      navigator.getGamepads = () => [pad as unknown as Gamepad, null, null, null]
    })
    await chooseFighterFriend(page, '?seed=9', ['Alex', 'Sam'])
    await page.getByTestId('friend-start').click()
    await page.waitForFunction(() => window.__friendFighter?.ready === true)
    await page.waitForFunction(() => window.__friendFighter!.frame > 150)
    const before = await readFighter(page)
    await page.evaluate(() => { (window as unknown as { __pad: { buttons: Array<{ pressed: boolean }> } }).__pad.buttons[15]!.pressed = true })
    await page.waitForTimeout(400)
    const after = await readFighter(page)
    expect(after.x[0]).toBeGreaterThan(before.x[0])
    expect(after.x[1]).toBeCloseTo(before.x[1], 5)
    await page.evaluate(() => { const p = (window as unknown as { __pad: { buttons: Array<{ pressed: boolean }> } }).__pad; p.buttons[15]!.pressed = false; p.buttons[9]!.pressed = true })
    await expect(page.getByTestId('ff-paused')).toBeVisible()
  })
})

test.describe('Tinderbox with a friend on a tablet', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true })
  test.setTimeout(100_000)
  test.skip(({ browserName }) => browserName !== 'chromium', 'DevTools touch events are Chromium only')

  test('each player has a stick and six buttons at their own end, and the two touch sets drive two fighters', async ({ page }) => {
    const errors = watchConsole(page)
    await chooseFighterFriend(page, '?seed=7&tablet=1', ['Alex', 'Sam'])
    await shot(page, 'tinderbox-friend-setup-tablet')
    const server = watchServer(page)
    await page.getByTestId('friend-start').click()
    await page.waitForFunction(() => window.__friendFighter?.ready === true)
    await expect(page.getByTestId('fighter-touch-controls-0')).toBeVisible()
    await expect(page.getByTestId('fighter-touch-controls-1')).toBeVisible()
    await page.waitForFunction(() => window.__friendFighter!.frame > 150)
    const c0 = await page.getByTestId('fighter-touch-controls-0').locator('.touch-stick').boundingBox()
    const c1 = await page.getByTestId('fighter-touch-controls-1').locator('.touch-stick').boundingBox()
    expect(c0!.x).toBeLessThan(200)
    expect(c1!.x + c1!.width).toBeGreaterThan(1024 - 200)
    // The buttons of each set sit inside its stick; the two sets never overlap.
    const b0 = await page.getByTestId('fighter-touch-controls-0').locator('.touch-buttons').boundingBox()
    const b1 = await page.getByTestId('fighter-touch-controls-1').locator('.touch-buttons').boundingBox()
    expect(b0!.x).toBeGreaterThan(c0!.x + c0!.width)
    expect(b1!.x + b1!.width).toBeLessThan(c1!.x)
    expect(b0!.x + b0!.width).toBeLessThan(b1!.x)
    await shot(page, 'tinderbox-friend-play-tablet')
    // Two thumbs at once: player one pushes the left stick right, player two pushes the right stick left.
    const cdp = await page.context().newCDPSession(page)
    const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    const s0 = centre(c0!)
    const s1 = centre(c1!)
    const before = await readFighter(page)
    const touchPoints = (a: { x: number; y: number }, b: { x: number; y: number }) => [{ x: a.x, y: a.y, id: 1 }, { x: b.x, y: b.y, id: 2 }]
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touchPoints(s0, s1) })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touchPoints({ x: s0.x + 50, y: s0.y }, { x: s1.x - 50, y: s1.y }) })
    await page.waitForTimeout(500)
    const during = await readFighter(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    expect(during.x[0]).toBeGreaterThan(before.x[0])
    expect(during.x[1]).toBeLessThan(before.x[1])
    expect(server).toEqual([])
    expect(errors).toEqual([])
  })

  test('a tablet held upright is asked to turn, and the match starts the moment it does', async ({ page }) => {
    // Headless Chromium really goes fullscreen on Start, and a fullscreen window cannot be resized to fake a rotation (as in mobile.spec.ts).
    await page.addInitScript(() => {
      Element.prototype.requestFullscreen = () => Promise.resolve()
      if (screen.orientation) Object.defineProperty(screen.orientation, 'lock', { value: () => Promise.resolve(), configurable: true })
    })
    await page.setViewportSize({ width: 768, height: 1024 })
    await chooseFighterFriend(page, '?seed=7&tablet=1', ['Alex', 'Sam'])
    const server = watchServer(page)
    await page.getByTestId('friend-start').click()
    await expect(page.getByTestId('rotate-overlay')).toBeVisible()
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.waitForFunction(() => window.__friendFighter?.ready === true)
    await expect(page.getByTestId('rotate-overlay')).toBeHidden()
    await expect(page.getByTestId('fighter-touch-controls-0')).toBeVisible()
    // Turning it upright mid-match pauses; turning back resumes.
    await page.setViewportSize({ width: 768, height: 1024 })
    await expect(page.getByTestId('rotate-overlay')).toBeVisible()
    const frozen = (await readFighter(page)).frame
    await page.waitForTimeout(300)
    expect((await readFighter(page)).frame).toBe(frozen)
    await page.setViewportSize({ width: 1024, height: 768 })
    await expect(page.getByTestId('rotate-overlay')).toBeHidden()
    await page.waitForFunction((f) => window.__friendFighter!.frame > f, frozen)
    expect(server).toEqual([])
  })

  test('a phone gets the written controls and says it is too small for two touch sets', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await chooseFighterFriend(page, '?seed=7', ['Alex', 'Sam'])
    await shot(page, 'tinderbox-friend-setup-390')
    await expect(page.getByTestId('friend-device-note')).toContainText('A phone is too small for two sets')
  })
})
