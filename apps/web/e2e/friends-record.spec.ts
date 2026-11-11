import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

/**
 * The friend head-to-head (M9) and the friend result (M7) on two devices: two browser contexts against the local relay (`wrangler dev`, started by
 * the run script with a throwaway signing secret the web dev server shares) and the in-memory database the e2e server uses. Nobody is signed in, so
 * each person is keyed by their browser. Set FRIENDS_SHOTS to a folder to save the screenshots the handoff names.
 */
const SHOTS = process.env.FRIENDS_SHOTS
const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const

interface Person {
  name: string
  page: Page
  context: BrowserContext
  /** POSTs to the site that carried a signed result, by this person. */
  recordCalls: number
  proofFrames: number
  seat: () => Promise<0 | 1>
}

async function person(browser: Browser, name: string, vp: (typeof VIEWPORTS)[number], touch: boolean): Promise<Person> {
  const use = test.info().project.use
  const context = await browser.newContext({
    baseURL: use.baseURL,
    storageState: use.storageState as never,
    viewport: { width: vp.width, height: vp.height },
    hasTouch: touch,
    extraHTTPHeaders: { 'x-dw-test': '1' },
  })
  await context.addInitScript((n) => {
    try {
      if (!window.localStorage.getItem('duelwise.name')) window.localStorage.setItem('duelwise.name', n)
    } catch {
      /* none */
    }
  }, name)
  const page = await context.newPage()
  const p: Person = { name, page, context, recordCalls: 0, proofFrames: 0, seat: async () => Number(await page.getByTestId('remote-game').getAttribute('data-you')) as 0 | 1 }
  page.on('request', (r) => {
    if (r.method() === 'POST' && (r.postData() ?? '').includes('"proof"')) p.recordCalls++
  })
  await page.routeWebSocket(/\/room\//, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    ws.onClose((c) => void server.close({ code: c ?? 1000 }))
    server.onMessage((m) => {
      if (typeof m === 'string' && m.startsWith('{"t":"result"')) p.proofFrames++
      ws.send(m)
    })
    server.onClose((c) => void ws.close({ code: c ?? 1000 }))
  })
  return p
}

function watch(p: Page): string[] {
  const errors: string[] = []
  p.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|ERR_|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`)
  })
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

async function shot(p: Page, vp: string, name: string) {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}-${test.info().project.name}-${vp}.png`, fullPage: true })
}

async function drop(mover: Person, other: Person, col: number) {
  const mine = mover.page.getByTestId('four-board')
  const before = Number(await mine.getAttribute('data-moves'))
  await expect(mine).toHaveAttribute('data-turn', 'you')
  await mover.page.getByTestId(`col-${col}`).click()
  await expect(other.page.getByTestId('four-board')).toHaveAttribute('data-moves', String(before + 1))
  await expect(other.page.getByTestId('four-board')).toHaveAttribute('data-settling', 'false')
}

async function resign(p: Person) {
  await p.page.getByTestId('friend-resign').click()
  await p.page.getByTestId('friend-resign-yes').click()
}

async function rematch(a: Person, b: Person) {
  await a.page.getByTestId('friend-rematch').click()
  await b.page.getByTestId('friend-rematch').click()
  for (const p of [a, b]) await expect(p.page.getByTestId('friend-result')).toHaveCount(0)
}

for (const vp of VIEWPORTS) {
  test(`three friend games make a record: You 2 and the mirror, one write per phone per game, a stranger sees none (${vp.name})`, async ({ browser }) => {
    const touch = test.info().project.name.includes('iphone')
    const ada = await person(browser, 'Ada', vp, touch)
    const sam = await person(browser, 'Sam', vp, touch)
    const errors = [...watch(ada.page), ...watch(sam.page)]
    await ada.page.goto(`/f?game=four`)
    await expect(ada.page.getByTestId('challenge-friends-link')).toBeVisible()
    await ada.page.getByTestId('challenge-make').click()
    await expect(ada.page.getByTestId('share-room')).toBeVisible()
    const link = (await ada.page.getByTestId('share-link').innerText()).trim()
    await sam.page.goto(link.slice(link.indexOf('/f/')))
    await expect(ada.page.getByTestId('remote-game')).toBeVisible()
    await expect(sam.page.getByTestId('remote-game')).toBeVisible()
    const seats = [await ada.seat(), await sam.seat()]
    expect(new Set(seats).size).toBe(2)
    const f = seats[0] === 0 ? ada : sam // moves first in game 1, wins it
    const l = f === ada ? sam : ada

    // Game 1: a real win for F.
    for (let i = 0; i < 3; i++) {
      await drop(f, l, 0)
      await drop(l, f, 1)
    }
    await f.page.getByTestId('col-0').click()
    for (const p of [f, l]) await expect(p.page.getByTestId('friend-result')).toBeVisible()
    for (const p of [f, l]) await expect(p.page.getByTestId('friend-record-line')).toBeVisible()
    await expect(f.page.getByTestId('friend-record-line')).toHaveText(`You 1, ${l.name} 0`)
    await expect(l.page.getByTestId('friend-record-line')).toHaveText(`You 0, ${f.name} 1`)
    await expect(f.page.getByTestId('friend-not-rated')).toContainText('Friend games are not rated')
    await expect(f.page.getByTestId('friend-ratings')).toHaveCount(0)
    await shot(f.page, vp.name, 'result-first-game')

    // Game 2: L resigns, F wins again. Game 3: F resigns, L wins one.
    await rematch(f, l)
    await resign(l)
    for (const p of [f, l]) await expect(p.page.getByTestId('friend-result-reason')).toContainText('resigned')
    await expect(f.page.getByTestId('friend-record-line')).toHaveText(`You 2, ${l.name} 0`)
    await rematch(f, l)
    await resign(f)
    for (const p of [f, l]) await expect(p.page.getByTestId('friend-result-reason')).toContainText('resigned')
    await expect(f.page.getByTestId('friend-record-line')).toHaveText(`You 2, ${l.name} 1`)
    await expect(l.page.getByTestId('friend-record-line')).toHaveText(`You 1, ${f.name} 2`)
    await shot(f.page, vp.name, 'result-record')
    await shot(l.page, vp.name, 'result-record-mirror')

    // The relay sent each phone one signed result per game, and each phone handed it over once.
    expect([f.proofFrames >= 3, l.proofFrames >= 3]).toEqual([true, true])
    expect([f.recordCalls, l.recordCalls]).toEqual([3, 3])

    // The friends list shows the same record, from each side.
    await f.page.goto('/friends')
    await expect(f.page.getByTestId('friend-row')).toHaveCount(1)
    await expect(f.page.getByTestId('friend-row-record')).toHaveText(`You 2, ${l.name} 1`)
    await expect(f.page.getByTestId('friends')).toContainText('3 games')
    await shot(f.page, vp.name, 'friends-list')
    await l.page.goto('/friends')
    await expect(l.page.getByTestId('friend-row-record')).toHaveText(`You 1, ${f.name} 2`)

    // Somebody who has never played a friend sees the empty page, not anyone's record.
    const stranger = await person(browser, 'Eve', vp, touch)
    await stranger.page.goto('/friends')
    await expect(stranger.page.getByTestId('friends-empty')).toBeVisible()
    await expect(stranger.page.getByTestId('friend-row')).toHaveCount(0)
    await shot(stranger.page, vp.name, 'friends-empty')
    expect(errors).toEqual([])
    await ada.context.close()
    await sam.context.close()
    await stranger.context.close()
  })

  test(`the friend result with both ratings and a long record, on the dev view (${vp.name})`, async ({ browser }) => {
    const touch = test.info().project.name.includes('iphone')
    const p = await person(browser, 'Ada', vp, touch)
    await p.page.goto('/dev/friend-result')
    await expect(p.page.getByTestId('dev-friend-long').getByTestId('friend-ratings')).toContainText('1240')
    await expect(p.page.getByTestId('dev-friend-long').getByTestId('friend-ratings-link')).toHaveAttribute('href', '/leaderboard/chess')
    await expect(p.page.getByTestId('dev-friend-long').getByTestId('friend-record-all')).toContainText('You 31')
    // nothing overflows sideways even with a long name
    const wide = await p.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    expect(wide).toBe(false)
    await shot(p.page, vp.name, 'result-with-ratings')
    await p.context.close()
  })
}
