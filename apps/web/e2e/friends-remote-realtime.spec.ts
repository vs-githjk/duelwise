import { mkdirSync } from 'node:fs'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

/**
 * Glasscut on two devices (slice 2, S9): two browser contexts against the local relay (`wrangler dev` on the port the run script gives
 * VITE_DUEL_RELAY_URL, with a throwaway DUEL_SIGNING_SECRET the web dev server shares). Each context is a separate person with its own
 * storage and socket, behind the dev latency shim (`?net=60,20`: 60 ms each way plus up to 20 ms jitter). A scripted hand plays each seat
 * (dev builds only, set through local storage), so a whole match runs to the relay's signed result. FRIENDS_SHOTS=<dir> saves screenshots.
 * window.__remotePuck is typed by apps/web/src/games/friends/useRemotePuck.ts.
 */
const SHOTS = process.env.FRIENDS_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const NET = '60,20'

interface Person {
  name: string
  page: Page
  context: BrowserContext
  /** While true a new socket to the relay is refused at once, like a phone with no signal. */
  blocked: boolean
  sockets: Array<{ close(o: { code: number }): Promise<void> }>
  /** Cuts the live socket and refuses new ones for `ms`. */
  outage(ms: number): Promise<void>
}

async function person(browser: Browser, name: string, bot: string | null, w: number, h: number, touch: boolean): Promise<Person> {
  const use = test.info().project.use
  const context = await browser.newContext({
    baseURL: use.baseURL,
    storageState: use.storageState as never,
    viewport: { width: w, height: h },
    hasTouch: touch,
    isMobile: touch,
    extraHTTPHeaders: { 'x-dw-test': '1' },
  })
  await context.addInitScript(([n, b]) => {
    try {
      window.localStorage.setItem('duelwise.name', n!)
      if (b) window.localStorage.setItem('duelwise.dev-bot', b)
    } catch {
      /* none */
    }
  }, [name, bot] as const)
  const page = await context.newPage()
  const p: Person = {
    name,
    page,
    context,
    blocked: false,
    sockets: [],
    outage: async (ms) => {
      p.blocked = true
      for (const ws of p.sockets.splice(0)) await ws.close({ code: 1001 }).catch(() => undefined)
      await new Promise((r) => setTimeout(r, ms))
      p.blocked = false
    },
  }
  await page.routeWebSocket(/\/room\//, (ws) => {
    if (p.blocked) {
      void ws.close({ code: 1001 })
      return
    }
    const server = ws.connectToServer()
    p.sockets.push(ws)
    ws.onMessage((m) => server.send(m))
    ws.onClose((c) => void server.close({ code: c ?? 1000 }))
    server.onMessage((m) => ws.send(m))
    server.onClose((c) => void ws.close({ code: c ?? 1000 }))
  })
  return p
}

function watch(p: Page): string[] {
  const errors: string[] = []
  p.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|ERR_|Failed to load resource|favicon/.test(m.text())) errors.push(`console: ${m.text()}`)
  })
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

async function shot(p: Page, vp: string, name: string) {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/glasscut-remote-${name}-${vp}.png` })
}

type Dbg = { ready: boolean; me: 0 | 1; frame: number; confirmed: number; over: boolean; score: [number, number]; fps: number; hashes: Record<string, string>; holds: number }
const dbg = (p: Page): Promise<Dbg | null> =>
  p.evaluate(() => {
    const d = window.__remotePuck
    return d ? { ready: d.ready, me: d.me, frame: d.frame, confirmed: d.confirmed, over: d.over, score: d.score, fps: d.fps, hashes: d.hashes, holds: d.holds } : null
  })

async function startRoom(browser: Browser, w: number, h: number, touch: boolean, vp: string, bots: [string | null, string | null]) {
  const ada = await person(browser, 'Ada', bots[0], w, h, touch)
  const sam = await person(browser, 'Sam', bots[1], w, h, touch)
  const errors = [...watch(ada.page), ...watch(sam.page)]
  await ada.page.goto(`/play/glasscut`)
  await ada.page.locator('[data-opponent-option="friend"]').click()
  await ada.page.locator('[data-how-option="link"]').click()
  await shot(ada.page, vp, 'setup')
  await ada.page.goto(`/f?game=puck&net=${NET}`)
  await ada.page.getByTestId('challenge-make').click()
  await expect(ada.page.getByTestId('share-room')).toBeVisible()
  await shot(ada.page, vp, 'share')
  const link = (await ada.page.getByTestId('share-link').innerText()).trim()
  expect(link).toContain('g=puck')
  await sam.page.goto(link.slice(link.indexOf('/f/')))
  for (const p of [ada, sam]) {
    await expect(p.page.getByTestId('rt-lobby')).toBeVisible()
    await expect(p.page.getByTestId('rt-ready')).toBeEnabled()
  }
  await shot(sam.page, vp, 'lobby')
  await ada.page.getByTestId('rt-ready').click()
  await sam.page.getByTestId('rt-ready').click()
  for (const p of [ada, sam]) {
    await expect(p.page.getByTestId('puck-stage')).toBeVisible()
    await expect.poll(async () => (await dbg(p.page))?.ready).toBe(true)
  }
  return { ada, sam, errors, close: async () => { await ada.context.close(); await sam.context.close() } }
}

const scoreOf = async (p: Page) => JSON.stringify((await dbg(p))?.score ?? null)

test.describe('Glasscut on two devices', () => {
  test.setTimeout(240_000)

  test('a full match under 60 ms of latency ends in one signed result, same score and same hashes on both pages (390)', async ({ browser }) => {
    const room = await startRoom(browser, 390, 844, true, '390', ['mouse', 'random'])
    const { ada, sam } = room
    // The seats are the relay's coin: the two pages sit at opposite ends of the same table.
    const seats = [(await dbg(ada.page))!.me, (await dbg(sam.page))!.me]
    expect(new Set(seats).size).toBe(2)
    await expect(ada.page.getByTestId('puck-stage')).toHaveAttribute('data-seat', String(seats[0]))
    // Let the match run, take the in-play shots, and check each goal reaches both pages.
    await ada.page.waitForTimeout(6000)
    await shot(ada.page, '390', `play-seat${seats[0]}`)
    await shot(sam.page, '390', `play-seat${seats[1]}`)
    const fps: number[] = []
    let last = ''
    let goals = 0
    const t0 = Date.now()
    while (Date.now() - t0 < 200_000) {
      if ((await ada.page.getByTestId('friend-result').count()) > 0 && (await sam.page.getByTestId('friend-result').count()) > 0) break
      const a = await dbg(ada.page)
      const b = await dbg(sam.page)
      if (a && b) {
        fps.push(a.fps, b.fps)
        const now = JSON.stringify(a.score)
        if (now !== last && a.over === false) {
          last = now
          goals++
          // A goal on one page reaches the other.
          await expect.poll(async () => (await scoreOf(ada.page)) === (await scoreOf(sam.page)) || (await scoreOf(ada.page)) !== now, { timeout: 4000 }).toBe(true)
        }
      }
      await ada.page.waitForTimeout(150)
    }
    for (const p of [ada, sam]) await expect(p.page.getByTestId('friend-result')).toBeVisible({ timeout: 30_000 })
    expect(goals).toBeGreaterThan(0)
    const title = await ada.page.getByTestId('friend-result-title').innerText()
    expect(await sam.page.getByTestId('friend-result-title').innerText()).toBe(title)
    await expect(ada.page.getByTestId('rp-final-score')).toBeVisible()
    await shot(ada.page, '390', 'result')
    await shot(sam.page, '390', 'result-friend')

    // The confirmed states agree on every frame both pages recorded: same sim, same inputs, same hash.
    const ha = (await dbg(ada.page))!.hashes
    const hb = (await dbg(sam.page))!.hashes
    const shared = Object.keys(ha).filter((f) => f in hb)
    expect(shared.length).toBeGreaterThan(10)
    for (const f of shared) expect(hb[f], `hash at frame ${f}`).toBe(ha[f])

    // The head-to-head card: one game for each side, from each side.
    const winner = title.replace(/ wins$/, '')
    const loser = winner === 'Ada' ? 'Sam' : 'Ada'
    const win = winner === 'Ada' ? ada : sam
    const lose = winner === 'Ada' ? sam : ada
    await expect(win.page.getByTestId('friend-record-line')).toHaveText(`You 1, ${loser} 0`)
    await expect(lose.page.getByTestId('friend-record-line')).toHaveText(`You 0, ${winner} 1`)
    // Median frame rate over the whole match.
    fps.sort((x, y) => x - y)
    const median = fps[Math.floor(fps.length / 2)] ?? 0
    test.info().annotations.push({ type: 'fps-median-390', description: String(median) })
    console.log(`FPS median ${median} over ${fps.length} samples; goals seen ${goals}; winner ${winner}`)
    expect(median).toBeGreaterThanOrEqual(55)
    expect(room.errors).toEqual([])
    await room.close()
  })

  test('a phone with no signal for 5 s sees Reconnecting, the friend sees Waiting, and the match finishes with matching hashes (390)', async ({ browser }) => {
    const room = await startRoom(browser, 390, 844, true, '390o', ['mouse', 'random'])
    const { ada, sam } = room
    await ada.page.waitForTimeout(3000)
    const before = (await dbg(ada.page))!.frame
    const out = sam.outage(5000)
    await expect(ada.page.getByTestId('rp-waiting')).toContainText('Waiting for Sam', { timeout: 8000 })
    await expect(sam.page.getByTestId('rp-waiting')).toContainText('Reconnecting', { timeout: 8000 })
    await shot(ada.page, '390', 'waiting')
    await out
    await expect(ada.page.getByTestId('rp-waiting')).toHaveCount(0, { timeout: 20_000 })
    await expect(sam.page.getByTestId('rp-waiting')).toHaveCount(0, { timeout: 20_000 })
    await expect.poll(async () => (await dbg(ada.page))!.frame, { timeout: 10_000 }).toBeGreaterThan(before + 60)
    for (const p of [ada, sam]) await expect(p.page.getByTestId('friend-result')).toBeVisible({ timeout: 200_000 })
    const ha = (await dbg(ada.page))!.hashes
    const hb = (await dbg(sam.page))!.hashes
    const shared = Object.keys(ha).filter((f) => f in hb)
    expect(shared.length).toBeGreaterThan(10)
    for (const f of shared) expect(hb[f], `hash at frame ${f}`).toBe(ha[f])
    expect(await ada.page.getByTestId('friend-result-title').innerText()).toBe(await sam.page.getByTestId('friend-result-title').innerText())
    await room.close()
  })

  test('desktop 1440: lobby, play, leaving counts as a resignation, and the head-to-head line', async ({ browser }) => {
    const room = await startRoom(browser, 1440, 900, false, '1440', [null, null])
    const { ada, sam } = room
    const s0 = [(await dbg(ada.page))!.me, (await dbg(sam.page))!.me]
    expect(new Set(s0).size).toBe(2)
    await ada.page.mouse.move(720, 700)
    await sam.page.mouse.move(720, 700)
    await ada.page.waitForTimeout(2500)
    await shot(ada.page, '1440', `play-seat${s0[0]}`)
    await shot(sam.page, '1440', `play-seat${s0[1]}`)
    // Ada leaves: Sam wins by resignation, and both see the card.
    await ada.page.getByTestId('rp-back').click()
    await expect(ada.page.getByTestId('rp-leave')).toBeVisible()
    await shot(ada.page, '1440', 'leave')
    await ada.page.getByTestId('rp-stay').click()
    await ada.page.getByTestId('rp-back').click()
    await ada.page.getByTestId('rp-leave-yes').click()
    await expect(sam.page.getByTestId('friend-result-title')).toHaveText('Sam wins', { timeout: 15_000 })
    await expect(sam.page.getByTestId('friend-result-reason')).toContainText('Ada resigned')
    await expect(sam.page.getByTestId('friend-record-line')).toHaveText('You 1, Ada 0')
    await shot(sam.page, '1440', 'result')
    await room.close()
  })
})
