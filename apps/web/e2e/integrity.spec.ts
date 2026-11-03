import { expect, test, type Page } from '@playwright/test'
import { decodeRecord, encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record.ts'
import { fleetCore } from '@duelwise/core/src/games/fleet/index.ts'
import { publishedLevels } from './published-levels'

const GAMES = {
  chess: { play: '/play/chess', board: 'chess-board', board_lb: '/leaderboard/chess' },
  four: { play: '/play/four-in-a-row', board: 'four-board', board_lb: '/leaderboard/four-in-a-row' },
} as const

async function devSignIn(page: Page, name: string) {
  await page.goto('/signin')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Dev sign in' }).click()
  await expect(page).toHaveURL(/\/play$/)
  await expect(page.getByTestId('user-menu')).toContainText(name)
}

async function startMatch(page: Page, game: keyof typeof GAMES, query = '') {
  await page.goto(GAMES[game].play + query)
  await page.waitForLoadState('networkidle')
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId(GAMES[game].board)).toBeVisible()
  await expect(page.getByTestId(GAMES[game].board)).toHaveAttribute('data-turn', 'you')
}

async function resign(page: Page) {
  await page.getByRole('button', { name: 'Resign' }).click()
  await page.getByRole('button', { name: 'Yes, resign' }).click()
  await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
  await expect(page.getByTestId('result-reason')).toHaveText('You resigned.')
}

for (const game of ['chess', 'four'] as const) {
  test.describe(`${game}: rated resign`, () => {
    test('resigning a counted match is a loss: the rating shown drops and the leaderboard reflects it', async ({ page }) => {
      await devSignIn(page, `res-${game}`)
      await startMatch(page, game)
      await resign(page)
      const elo = page.getByTestId('result-elo')
      await expect(elo).toContainText(/Rating 1000 to \d+/)
      const text = (await elo.textContent()) ?? ''
      const after = Number(/to (\d+)/.exec(text)![1])
      expect(after).toBeLessThan(1000)
      await page.goto(GAMES[game].board_lb)
      await expect(page.getByTestId('leaderboard-me')).toContainText(`Your rating: ${after} after 1 counted match`)
    })

    test('an unrated test-seed match resigns without touching the rating', async ({ page }) => {
      await devSignIn(page, `unr-${game}`)
      await startMatch(page, game, '?seed=7')
      await resign(page)
      await expect(page.getByTestId('result-elo')).toHaveCount(0)
      await expect(page.getByTestId('result-unrated')).toBeVisible()
      await page.goto(GAMES[game].board_lb)
      await expect(page.getByTestId('leaderboard-me')).toHaveCount(0)
    })
  })
}

test('closing the page during a counted match sends a beacon that resigns it', async ({ page }) => {
  await devSignIn(page, 'leaver')
  await startMatch(page, 'four')
  await page.goto('/leaderboard/four-in-a-row') // a full navigation fires pagehide on the play page
  await expect(async () => {
    await page.reload()
    await expect(page.getByTestId('leaderboard-me')).toContainText('after 1 counted match')
  }).toPass({ timeout: 15_000 })
})

/** Lets the match start but makes the finished record's upload (the multipart server function) fail. */
async function failServerUpload(page: Page) {
  await page.route(/_serverFn/, async (route) => {
    const type = route.request().headers()['content-type'] ?? ''
    if (type.includes('multipart/form-data')) await route.abort('failed')
    else await route.continue()
  })
}

/** Drops stones while it is the player's turn until the result panel shows. */
async function playFourToTheEnd(page: Page) {
  const board = page.getByTestId('four-board')
  const panel = page.getByTestId('result-panel')
  for (let i = 0; i < 60 && !(await panel.isVisible()); i++) {
    if ((await board.getAttribute('data-turn').catch(() => null)) === 'you') {
      const before = await board.getAttribute('data-moves')
      await page.getByTestId(`col-${i % 7}`).click({ trial: false, timeout: 2000 }).catch(() => {})
      await expect(async () => {
        if (await panel.isVisible()) return
        expect(await board.getAttribute('data-moves')).not.toBe(before)
      }).toPass({ timeout: 3000 }).catch(() => {})
    } else {
      await page.waitForTimeout(100)
    }
  }
  await expect(panel).toBeVisible()
}

test('a finished match whose upload failed is delivered by the pagehide beacon and counts', async ({ page }) => {
  await devSignIn(page, 'beaconer')
  await failServerUpload(page)
  // The cyclic-column player cannot be relied on to finish against the measured Easy agent, so the dev-only random opponent plays seat 1.
  await startMatch(page, 'four', '?opponent=random')
  await playFourToTheEnd(page)
  await expect(page.getByTestId('result-upload')).toContainText('next time you open a game')
  // Playwright does not report sendBeacon requests, so the proof is the server effect: only the beacon can have delivered it.
  await page.goto('/leaderboard/four-in-a-row')
  await expect(async () => {
    await page.reload()
    await expect(page.getByTestId('leaderboard-me')).toContainText('after 1 counted match')
  }).toPass({ timeout: 15_000 })
})

test('a record that no request could deliver stays in localStorage and the next game page sends it', async ({ page }) => {
  await devSignIn(page, 'retrier')
  await failServerUpload(page)
  // The pagehide beacon bypasses page.route, so make it deliver nothing: only retryPending can send the record.
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false
  })
  let blockFinish = true
  let delivered = 0
  await page.route(/\/api\/finish$/, (route) => {
    if (blockFinish) return route.abort('failed')
    delivered++
    return route.continue()
  })
  // The cyclic-column player cannot be relied on to finish against the measured Easy agent, so the dev-only random opponent plays seat 1.
  await startMatch(page, 'four', '?opponent=random')
  await playFourToTheEnd(page)
  await expect(page.getByTestId('result-upload')).toBeVisible()
  const pendingKeys = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('duelwise.pending-finish.')))
  expect(await pendingKeys()).toHaveLength(1)
  await page.goto('/leaderboard/four-in-a-row')
  expect(delivered).toBe(0)
  expect(await pendingKeys()).toHaveLength(1)
  blockFinish = false
  await page.goto('/play/four-in-a-row') // retryPending runs on mount
  await expect(async () => expect(await pendingKeys()).toHaveLength(0)).toPass({ timeout: 15_000 })
  // Dev StrictMode mounts the effect twice, so the request may repeat; the server must settle the match once.
  expect(delivered).toBeGreaterThanOrEqual(1)
  await page.goto('/leaderboard/four-in-a-row')
  await expect(page.getByTestId('leaderboard-me')).toContainText('after 1 counted match')
})

// ---- Stormglass (fleet): a counted match is played on the server --------------------------------

/** The page's server-function replies are seroval JSON; this reads the few node kinds they use (numbers, strings, constants, arrays, objects). */
function sero(n: any, refs = new Map<number, unknown>()): any {
  switch (n.t) {
    case 0:
    case 1:
      return n.s
    case 2:
      return [null, undefined, true, false][n.s]
    case 4:
      return refs.get(n.i)
    case 9: {
      const a: unknown[] = []
      refs.set(n.i, a)
      for (const x of n.a) a.push(sero(x, refs))
      return a
    }
    case 10: {
      const o: Record<string, unknown> = {}
      refs.set(n.i, o)
      n.p.k.forEach((k: string, j: number) => (o[k] = sero(n.p.v[j], refs)))
      return o
    }
    default:
      throw new Error(`unknown node ${n.t}`)
  }
}

interface Turn {
  url: string
  post: string
  headers: Record<string, string>
  text: string
  status: number
  reply: { view?: any; over?: boolean; reveal?: { seed: number; agentActions: number[] }; error?: string }
}

/** Records every fleetTurn server-function call of the page: what it sent and what the server answered. */
function watchTurns(page: Page): Turn[] {
  const turns: Turn[] = []
  page.on('response', async (res) => {
    const m = /\/_serverFn\/([^?]+)/.exec(res.url())
    if (!m || !Buffer.from(m[1]!, 'base64').toString().includes('fleetTurn')) return
    const text = await res.text().catch(() => '')
    if (!text) return
    const req = res.request()
    turns.push({ url: res.url(), post: req.postData() ?? '', headers: await req.allHeaders(), text, status: res.status(), reply: sero(JSON.parse(text)).result })
  })
  return turns
}

/** Aims at the first open square and fires it, then waits until that square shows its result. Returns false when the match is over. */
async function fireNext(page: Page): Promise<boolean> {
  const root = page.getByTestId('fleet-page')
  if ((await root.getAttribute('data-turn')) === 'over') return false
  await expect(root).toHaveAttribute('data-turn', /you|over/)
  if ((await root.getAttribute('data-turn')) === 'over') return false
  const cell = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').first()
  const id = (await cell.getAttribute('data-testid'))!
  await cell.click()
  await cell.click()
  await expect(page.getByTestId(id)).not.toHaveAttribute('data-state', 'open')
  return true
}

const cellsOf = (p: { cell: number; vertical: boolean; length: number }) => Array.from({ length: p.length }, (_, i) => p.cell + i * (p.vertical ? 10 : 1))

/** A request for the same match with the setup swapped for another legal fleet (rows 0, 2, 4, 6, 8, all across, from column 0). */
const otherSetupBody = (post: string) => post.replace(/"a":\[[^\]]*\]/, `"a":[${[0, 20, 40, 60, 80].map((n) => `{"t":0,"s":${n}}`).join(',')}]`)

test.describe('fleet: a counted match', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('the browser never holds an enemy ship before it is hit or sunk, the seed is 0 until the end, and a second setup is refused', async ({ page }) => {
    test.setTimeout(180_000)
    await devSignIn(page, 'fleeter')
    const turns = watchTurns(page)
    const started: string[] = []
    page.on('response', async (res) => {
      if (res.request().resourceType() === 'fetch' && /_serverFn/.test(res.url())) {
        const t = await res.text().catch(() => '')
        if (t.includes('"sealed"')) started.push(t)
      }
    })
    await page.goto('/play/stormglass?hold=0')
    await page.getByTestId('fleet-ready').click()
    const root = page.getByTestId('fleet-page')
    await expect(root).toHaveAttribute('data-counted', 'true')
    await expect(root).toHaveAttribute('data-phase', 'play')
    // The start reply withholds the seed and says the match is sealed.
    expect(started.length).toBeGreaterThan(0)
    const startReply = sero(JSON.parse(started[0]!)).result
    expect(startReply.sealed).toBe(true)
    expect(startReply.seed).toBe(0)

    // A second, different setup for the same match is refused before and after shots, and changes nothing.
    const first = turns[0]!
    expect(first.reply.view.phase).toBe('play')
    const refuse = async (body: string) => {
      const r = await page.request.post(first.url, { data: body, headers: Object.fromEntries(Object.entries(first.headers).filter(([k]) => !['content-length', 'host'].includes(k))) })
      expect(r.status()).toBe(409)
    }
    await refuse(otherSetupBody(first.post))
    await fireNext(page)
    await fireNext(page)
    await refuse(first.post)
    await refuse(otherSetupBody(first.post))

    let shots = 0
    for (let i = 0; i < 100; i++) {
      // The board shows exactly my shots: no other enemy square is anything but open water.
      const marked = await page.locator('[data-testid^="fleet-cell-"]:not([data-testid="fleet-cell-board"])').evaluateAll((els) => els.filter((e) => e.getAttribute('data-state') !== 'open').length)
      if ((await root.getAttribute('data-turn')) !== 'over') expect(marked).toBe(await page.locator('[data-testid^="fleet-cell-"][data-state="hit"], [data-testid^="fleet-cell-"][data-state="miss"], [data-testid^="fleet-cell-"][data-state="sunk"]').count())
      if (!(await fireNext(page))) break
      shots++
    }
    await expect(page.getByTestId('result-panel')).toBeVisible()
    // A counted match links to its report (F10), and the panel names shots, not moves.
    await expect(page.getByTestId('result-report-link')).toHaveAttribute('href', /\/report\//)
    // The browser-built record was accepted by the local server: the page shows the rating it moved, and the board counts the match.
    await expect(page.getByTestId('result-elo')).toContainText(/Rating 1000 to \d+/)
    await page.goto('/leaderboard/stormglass')
    await expect(page.getByTestId('leaderboard-me')).toContainText('after 1 counted match')

    const replies = turns.filter((t) => t.reply && !t.reply.error)
    const last = replies.at(-1)!
    expect(last.reply.over).toBe(true)
    const enemy: Array<{ id: number; cell: number; vertical: boolean; length: number }> = last.reply.view.reveal
    expect(enemy).toHaveLength(5)
    expect(last.reply.reveal!.seed).toBeGreaterThan(0)
    for (const t of replies.slice(0, -1)) {
      expect(t.reply.over).toBe(false)
      expect(t.reply.reveal).toBeUndefined()
      expect(t.reply.view.reveal).toBeNull()
      expect(t.text).not.toContain('agentActions')
      expect(t.text).not.toContain('"seed"')
      const hits = new Set<number>(t.reply.view.shots.filter((m: any) => m.hit).map((m: any) => m.cell))
      const sunkIds = new Set<number>(t.reply.view.sunk.map((p: any) => p.id))
      // Every enemy ship in the reply is a sunk one, and no ship that is still afloat appears.
      for (const p of enemy) {
        if (sunkIds.has(p.id)) expect(cellsOf(p).every((c) => hits.has(c))).toBe(true)
        else expect(cellsOf(p).every((c) => hits.has(c))).toBe(false)
      }
      expect(t.reply.view.sunk).toHaveLength(sunkIds.size)
    }
    // What the page sent: only my own actions (setup first, then one more each time), never a seed or the opponent's moves.
    const sentLists = turns.map((t) => JSON.stringify(sero(JSON.parse(t.post).t).data.actions))
    expect(sentLists.length).toBeGreaterThan(5)
    expect(shots).toBeGreaterThan(10)
  })

  test('the aside tells a counted-match player that leaving resigns, and the result strip fits the panel at 360', async ({ page }) => {
    test.setTimeout(180_000)
    await devSignIn(page, 'asider')
    await page.goto('/play/stormglass?hold=0')
    await page.getByTestId('fleet-ready').click()
    const root = page.getByTestId('fleet-page')
    await expect(root).toHaveAttribute('data-counted', 'true')
    await expect(page.getByTestId('agent-card')).toBeVisible()
    await expect(page.getByTestId('leaving-notice')).toContainText(/resigns a counted match/)
    await expect(page.getByTestId('opponent-style')).not.toBeEmpty()
    await expect(page.getByTestId('fleet-legend')).toContainText('Sunk')
    // A published level shows no badge; a level still in training says so.
    await expect(page.getByTestId('preview-badge')).toHaveCount(publishedLevels('fleet').includes('easy') ? 0 : 1)
    // Fire still fits the 360 x 780 screen with the aside present, measured as the design does (section 2.2): page scrolled so the HUD is at the top.
    await page.getByTestId('fleet-hud').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY))
    await expect(page.getByTestId('fleet-fire')).toBeInViewport({ ratio: 1 })
    for (let i = 0; i < 100; i++) if (!(await fireNext(page))) break
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('fleet-reveal')).toBeVisible()
    const fit = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="result-panel"]') as HTMLElement
      const reveal = document.querySelector('[data-testid="fleet-reveal"]') as HTMLElement
      // The win's decorative chips are absolutely positioned and may pass the edge; they are not layout.
      panel.querySelectorAll('.result-chips').forEach((n) => n.remove())
      const cs = getComputedStyle(panel)
      const pr = panel.getBoundingClientRect()
      return {
        scrollWidth: panel.scrollWidth,
        clientWidth: panel.clientWidth,
        contentRight: pr.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
        revealRight: reveal.getBoundingClientRect().right,
      }
    })
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth)
    expect(fit.revealRight).toBeLessThanOrEqual(fit.contentRight + 0.5)
  })

  test('while a match is starting the level buttons are off and the header keeps the match\'s opponent', async ({ page }) => {
    test.setTimeout(60_000)
    await devSignIn(page, 'slowstart')
    await page.goto('/play/stormglass?hold=0')
    await page.route(/_serverFn/, async (route) => {
      await new Promise((r) => setTimeout(r, 800))
      await route.continue()
    })
    await page.getByTestId('fleet-ready').click()
    const champion = page.locator('[data-persona="champion"] input')
    await expect(champion).toBeDisabled()
    await page.locator('[data-persona="champion"]').click({ force: true }).catch(() => undefined)
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-phase', 'play')
    await expect(page.getByTestId('header-persona')).toContainText('Pip (Easy)')
    await expect(page.getByTestId('agent-card')).toContainText('Pip')
  })

  test('a record of a game nobody played through the server is refused, with the log reason', async ({ page }) => {
    test.setTimeout(180_000)
    await devSignIn(page, 'forger')
    // Keep the honest record on the page: its upload fails and no beacon can deliver it.
    await page.route(/_serverFn/, async (route) => {
      if ((route.request().headers()['content-type'] ?? '').includes('multipart/form-data')) await route.abort('failed')
      else await route.continue()
    })
    await page.addInitScript(() => {
      navigator.sendBeacon = () => false
    })
    await page.route(/\/api\/finish$/, (route) => route.abort('failed'))
    await page.goto('/play/stormglass?hold=0')
    await page.getByTestId('fleet-ready').click()
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-counted', 'true')
    for (let i = 0; i < 100; i++) if (!(await fireNext(page))) break
    await expect(page.getByTestId('result-panel')).toBeVisible()
    const pending = await page.evaluate(() => {
      const k = Object.keys(localStorage).find((x) => x.startsWith('duelwise.pending-finish.'))
      return k ? localStorage.getItem(k) : null
    })
    expect(pending).not.toBeNull()
    const honest = decodeRecord(new Uint8Array(Buffer.from(pending!, 'base64')))
    expect(honest.game).toBe('fleet')
    expect(honest.seed).toBeGreaterThan(0)

    // A game nobody played through the server, but one the core accepts end to end: it replays, its result and hash are right.
    // Only the server's own log of the match can tell it from the real one.
    const fabricated = (() => {
      let st = fleetCore.init(honest.seed)
      const actions: MatchRecordV1['actions'] = []
      const fleet = (row0: number) => [5, 4, 3, 3, 2].map((_, i) => (row0 + 2 * i) * 10)
      const mine = fleet(0)
      const theirs = fleet(1)
      for (let i = 0; i < 5; i++) {
        st = fleetCore.step(st, [{ kind: 'place', cell: mine[i]!, vertical: false }, { kind: 'place', cell: theirs[i]!, vertical: false }])
        actions.push([i, 0, mine[i]!], [i, 1, theirs[i]!])
      }
      for (let cell = 0, tick = 5; !fleetCore.terminal(st); tick++) {
        const seat = fleetCore.toAct(st)[0]!
        const c = seat === 0 ? cell : cell++
        st = fleetCore.step(st, seat === 0 ? [{ kind: 'shot', cell: c }, null] : [null, { kind: 'shot', cell: c }])
        actions.push([tick, seat, 200 + c])
      }
      return { ...honest, actions, result: fleetCore.result(st)!, finalHash: fleetCore.hash(st), humanInputTimesMs: undefined } as MatchRecordV1
    })()
    // A changed shot and a moved fleet are pinned in server/sealed-duel.test.ts (they reach the same log check, each on its own match).
    const r = await page.request.post('/api/finish', { data: Buffer.from(encodeRecord(fabricated)), headers: { 'content-type': 'application/gzip' } })
    expect(r.status()).toBe(200)
    const body = (await r.json()) as { valid: boolean; reason?: string; elo?: { before: number; after: number } }
    expect(body).toMatchObject({ valid: false, reason: 'record does not match the logged turns' })
    // The forgery never gains. The server's log settles the rating: the real game's loss is charged and a real win moves nothing (server/loss-dodge.test.ts pins both).
    if (honest.result.winner === 1) expect(body.elo!.after).toBeLessThan(body.elo!.before)
    else expect(body.elo).toBeUndefined()
  })

  test('a shot refused because the match was settled returns to setup, once, and the phone shows why', async ({ page }) => {
    test.setTimeout(60_000)
    await devSignIn(page, 'settled')
    await page.setViewportSize({ width: 360, height: 740 })
    const statuses: number[] = []
    const started: string[] = []
    page.on('response', async (res) => {
      const m = /\/_serverFn\/([^?]+)/.exec(res.url())
      if (!m) return
      if (Buffer.from(m[1]!, 'base64').toString().includes('fleetTurn')) statuses.push(res.status())
      const t = await res.text().catch(() => '')
      if (t.includes('"sealed"')) started.push(t)
    })
    await page.goto('/play/stormglass?hold=0')
    await page.getByTestId('fleet-ready').click()
    const root = page.getByTestId('fleet-page')
    await expect(root).toHaveAttribute('data-phase', 'play')
    await fireNext(page)
    await expect(root).toHaveAttribute('data-turn', 'you')
    await expect.poll(() => statuses).toEqual([200, 200])
    // Anything that settles the row while the page is open, such as the abandon sweep after a long pause.
    const { matchId } = sero(JSON.parse(started[0]!)).result as { matchId: string }
    const settled = await page.request.post('/api/resign', { data: { matchId, tick: 0 } })
    expect(settled.status()).toBe(200)
    // The player is mid-match, scrolled down to the last row of the target grid.
    const cell = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').last()
    await cell.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 8))
    const scrolled = await page.evaluate(() => scrollY)
    await cell.click()
    await cell.click()
    await expect(root).toHaveAttribute('data-phase', 'setup')
    const line = page.getByTestId('fleet-failure')
    await expect(line).toHaveText('This match has ended. Place your fleet to start a new one.')
    // Where the line sits on the page is above that scroll, so only bringing it into view can put it on screen.
    const lineBottom = await line.evaluate((el) => el.getBoundingClientRect().bottom + window.scrollY)
    expect(lineBottom).toBeLessThan(scrolled)
    await expect(line).toBeInViewport({ ratio: 1 })
    expect(statuses).toEqual([200, 200, 409])
  })

  test('a signed-in player who resigns before the first shot is told the match does not count', async ({ page }) => {
    test.setTimeout(60_000)
    await devSignIn(page, 'noshot')
    await page.goto('/play/stormglass?hold=0')
    await page.getByTestId('fleet-ready').click()
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-counted', 'true')
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-phase', 'play')
    await page.getByTestId('fleet-resign').click()
    await page.getByTestId('fleet-resign-yes').click()
    await expect(page.getByTestId('result-upload')).toHaveText('No shot was fired, so this match does not count.')
    await expect(page.getByTestId('result-panel')).not.toContainText('Sign in')
    await expect(page.getByTestId('result-elo')).toHaveCount(0)
  })

  test('a setup or a shot that fails twice shows a line on the page, and the next try recovers', async ({ page }) => {
    test.setTimeout(120_000)
    await devSignIn(page, 'flaky')
    let aborts = 0
    let abortLeft = 0
    await page.route(/_serverFn\//, async (route) => {
      const m = /\/_serverFn\/([^?]+)/.exec(route.request().url())
      const isTurn = !!m && Buffer.from(m[1]!, 'base64').toString().includes('fleetTurn')
      if (isTurn && abortLeft > 0) {
        abortLeft--
        aborts++
        await route.abort('failed')
      } else await route.continue()
    })
    await page.setViewportSize({ width: 360, height: 740 })
    await page.goto('/play/stormglass?hold=0')
    const root = page.getByTestId('fleet-page')
    // The failure line must fit its slot at 360 wide: no clipped text, and it ends above the button below it.
    const fits = async () => {
      const box = await page.getByTestId('fleet-failure').evaluate((el) => ({ clipped: el.scrollHeight > el.clientHeight, bottom: el.getBoundingClientRect().bottom }))
      expect(box.clipped).toBe(false)
      return box.bottom
    }
    // Setup: both tries fail.
    abortLeft = 2
    await page.getByTestId('fleet-ready').click()
    await expect(page.getByRole('alert')).toContainText(/could not start/i)
    const setupBottom = await fits()
    expect(setupBottom).toBeLessThanOrEqual((await page.getByTestId('fleet-ready').boundingBox())!.y)
    await expect(root).toHaveAttribute('data-phase', 'setup')
    expect(aborts).toBe(2)
    // Ready again works, and the line goes.
    await page.getByTestId('fleet-ready').click()
    await expect(root).toHaveAttribute('data-phase', 'play')
    await expect(page.getByRole('alert')).toHaveCount(0)
    // A shot: both tries fail, the line shows, the turn is still mine.
    await expect(root).toHaveAttribute('data-turn', 'you')
    abortLeft = 2
    const cell = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').first()
    await cell.click()
    await cell.click()
    await expect(page.getByTestId('fleet-failure')).toBeVisible()
    await expect(page.getByRole('alert')).toContainText(/shot at [A-J]\d+ not sent\. press fire to send it again/i)
    await fits()
    expect(aborts).toBe(4)
    // Another square now: the lost shot stays aimed and locked (Fire can only send it again), so the tap changes nothing and the line stays true.
    const other = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').nth(5)
    await other.click()
    await other.click()
    await expect(page.getByRole('alert')).toHaveCount(1)
    await expect(page.locator('[data-testid^="fleet-cell-"]:is([data-state="hit"],[data-state="miss"],[data-state="sunk"])')).toHaveCount(0)
    // Fire sends the lost shot and the match goes on, with no error line left.
    await page.getByTestId('fleet-fire').click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('[data-testid^="fleet-cell-"]:is([data-state="hit"],[data-state="miss"],[data-state="sunk"])')).toHaveCount(1)
    // A failed shot, then Resign: the over screen keeps no stale "fire again" line.
    abortLeft = 2
    const third = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').nth(7)
    await third.click()
    await third.click()
    await expect(page.getByRole('alert')).toContainText(/shot at [A-J]\d+ not sent\. press fire to send it again/i)
    await page.getByTestId('fleet-resign').click()
    await page.getByTestId('fleet-resign-yes').click()
    await expect(root).toHaveAttribute('data-turn', 'over')
    await expect(page.getByRole('alert')).toHaveCount(0)
    // The lost square is not kept aimed on the over screen either.
    await expect(page.getByTestId('fleet-aim-chip')).toHaveText('')
    await expect(page.locator('[data-testid^="fleet-cell-"][data-aimed]')).toHaveCount(0)
  })
})

test('fleet: the match-ending reply is lost and the player resigns: a win in the log says nothing was counted, a loss shows its rating, never "Sign in to get a rating"', async ({ page }) => {
  test.setTimeout(180_000)
  await devSignIn(page, 'unseen')
  let dropped = 0
  await page.route(/_serverFn\//, async (route) => {
    const m = /\/_serverFn\/([^?]+)/.exec(route.request().url())
    const isTurn = !!m && Buffer.from(m[1]!, 'base64').toString().includes('fleetTurn')
    if (!isTurn) return route.continue()
    // The server plays the turn for real; only the reply that carries the end (it alone carries the agent's actions) never arrives.
    const reply = await route.fetch()
    if ((await reply.text()).includes('agentActions')) {
      dropped++
      return route.abort('failed')
    }
    return route.fulfill({ response: reply })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/play/stormglass?hold=0')
  await page.getByTestId('fleet-ready').click()
  const root = page.getByTestId('fleet-page')
  await expect(root).toHaveAttribute('data-turn', 'you')
  // A careful hunt (checkerboard, then the neighbours of a hit), so the player usually finishes first and the lost reply is a win; either way is checked below.
  const queue: number[] = []
  const tried = new Set<number>()
  const hunt = Array.from({ length: 100 }, (_, c) => c).sort((a, b) => ((Math.floor(a / 10) + a) % 2) - ((Math.floor(b / 10) + b) % 2) || a - b)
  while (dropped === 0) {
    const cell = queue.shift() ?? hunt.find((c) => !tried.has(c))
    if (cell === undefined) break
    tried.add(cell)
    const c = page.getByTestId(`fleet-cell-${cell}`)
    if ((await c.getAttribute('data-state')) !== 'open') continue
    await c.click()
    await c.click()
    await expect(async () => {
      expect((await root.getAttribute('data-turn')) === 'you' || dropped > 0 || (await root.getAttribute('data-turn')) === 'over').toBe(true)
    }).toPass({ timeout: 15_000 })
    if ((await c.getAttribute('data-state')) === 'hit') {
      const r = Math.floor(cell / 10)
      for (const n of [cell - 10, cell + 10, r === Math.floor((cell - 1) / 10) ? cell - 1 : -1, r === Math.floor((cell + 1) / 10) ? cell + 1 : -1]) if (n >= 0 && n < 100 && !tried.has(n)) queue.unshift(n)
    }
  }
  await expect(page.getByTestId('fleet-failure')).toContainText(/not sent/i)
  await page.getByTestId('fleet-resign').click()
  await page.getByTestId('fleet-resign-yes').click()
  // The panel mounts only once the resign reply is in, so its heading is final the first time it can be seen: it never shows a loss and then flips.
  const panel = page.getByTestId('result-panel')
  await expect(panel).toBeVisible()
  const firstOutcome = await panel.getAttribute('data-outcome')
  await expect(root).toHaveAttribute('data-turn', 'over')
  // Settled either way: won in the log, so nothing was counted and the line says so; lost in the log, so charged like a resign with its rating shown.
  const upload = page.getByTestId('result-upload')
  const elo = page.getByTestId('result-elo')
  await expect(async () => {
    const said = (await upload.count()) > 0 ? ((await upload.textContent()) ?? '') : ''
    expect(said.includes('nothing was counted') || (await elo.count()) > 0).toBe(true)
  }).toPass({ timeout: 20_000 })
  await expect(page.getByText('Sign in to get a rating')).toHaveCount(0)
  // The heading agrees with the line under it: a win in the log reads as a win, a loss as a loss.
  const wonInLog = (await upload.count()) > 0 && ((await upload.textContent()) ?? '').includes('nothing was counted')
  await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', wonInLog ? 'win' : 'loss')
  expect(firstOutcome).toBe(wonInLog ? 'win' : 'loss')
  if (wonInLog) {
    // A win the server never counted claims no progress: no next level, no ladder clear, nothing written to the path.
    await expect(page.getByTestId('play-next')).toHaveCount(0)
    const path = JSON.parse((await page.evaluate(() => localStorage.getItem('duelwise.path'))) ?? '{}') as { fleet?: Record<string, boolean> }
    expect(path.fleet?.easy ?? false).toBe(false)
  }
  expect((await upload.count()) > 0 && ((await upload.textContent()) ?? '').includes('nothing was counted') && (await elo.count()) > 0).toBe(false)
})

/** A counted Stormglass match on a page that cannot encode a record (no CompressionStream), played until the final reply leaves "Match over, but not saved". Mode picks the play style: a careful hunt usually wins, a scatter usually loses. */
async function playToRecordFailure(page: Page, mode: 'hunt' | 'scatter') {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).CompressionStream
    // Playwright does not report sendBeacon requests: keep a log of them that survives a reload.
    const real = navigator.sendBeacon.bind(navigator)
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      try { sessionStorage.setItem('beacons', JSON.stringify([...JSON.parse(sessionStorage.getItem('beacons') ?? '[]'), String(url)])) } catch {}
      return real(url, data)
    }
  })
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/play/stormglass?hold=0')
  await page.getByTestId('fleet-ready').click()
  const root = page.getByTestId('fleet-page')
  await expect(root).toHaveAttribute('data-turn', 'you')
  const queue: number[] = []
  const tried = new Set<number>()
  const order = mode === 'hunt'
    ? Array.from({ length: 100 }, (_, c) => c).sort((a, b) => ((Math.floor(a / 10) + a) % 2) - ((Math.floor(b / 10) + b) % 2) || a - b)
    : Array.from({ length: 100 }, (_, c) => (c * 37) % 100)
  const failure = page.getByTestId('fleet-failure')
  while ((await failure.count()) === 0 && (await root.getAttribute('data-turn')) !== 'over') {
    const cell = queue.shift() ?? order.find((c) => !tried.has(c))
    if (cell === undefined) break
    tried.add(cell)
    const c = page.getByTestId(`fleet-cell-${cell}`)
    if ((await c.getAttribute('data-state')) !== 'open') continue
    await c.click()
    await c.click()
    await expect(async () => {
      expect((await root.getAttribute('data-turn')) === 'you' || (await failure.count()) > 0).toBe(true)
    }).toPass({ timeout: 15_000 })
    if (mode === 'hunt' && (await c.getAttribute('data-state')) === 'hit') {
      const r = Math.floor(cell / 10)
      for (const n of [cell - 10, cell + 10, r === Math.floor((cell - 1) / 10) ? cell - 1 : -1, r === Math.floor((cell + 1) / 10) ? cell + 1 : -1]) if (n >= 0 && n < 100 && !tried.has(n)) queue.unshift(n)
    }
  }
  await expect(failure).toHaveText('Match over, but not saved. Press Resign to settle it.')
  expect(await failure.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(false)
  // The server's log has a win when all seventeen enemy ship squares are hit on the board the page shows.
  const won = (await page.locator('[data-testid^="fleet-cell-"][data-state="hit"]').count()) === 17
  return { root, failure, won }
}

/** Plays fresh matches (a new page each time, signed in through the shared context) until one ends the wanted way, at most 10 times, and logs which branch it reached. */
async function reachRecordFailure(page: Page, want: 'won' | 'lost', mode: 'hunt' | 'scatter', label: string) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const p = attempt === 1 ? page : await page.context().newPage()
    const got = await playToRecordFailure(p, mode)
    if (got.won === (want === 'won')) {
      console.log(`BRANCH ${label}: ${want} log reached on attempt ${attempt}`)
      test.info().annotations.push({ type: 'branch', description: `${want} on attempt ${attempt}` })
      return { page: p, ...got }
    }
    if (p !== page) await p.close()
    else await page.goto('about:blank')
  }
  throw new Error(`${label}: no ${want} log in 10 matches`)
}

for (const [want, mode] of [['won', 'hunt'], ['lost', 'scatter']] as const) {
  test(`fleet: a page that cannot make the record, ${want} in the log: Resign sends exactly one request and settles it as the log has it`, async ({ page }) => {
    test.setTimeout(540_000)
    await devSignIn(page, `norecord-${want}`)
    const { page: p, root } = await reachRecordFailure(page, want, mode, `resign-${want}`)
    const resigns: string[] = []
    p.on('request', (r) => { if (r.url().includes('/api/resign')) resigns.push(r.url()) })
    await p.getByTestId('fleet-resign').click()
    await p.getByTestId('fleet-resign-yes').click()
    await expect(root).toHaveAttribute('data-turn', 'over')
    const upload = p.getByTestId('result-upload')
    const elo = p.getByTestId('result-elo')
    const panel = p.getByTestId('result-panel')
    if (want === 'won') {
      await expect(upload).toContainText('nothing was counted', { timeout: 20_000 })
      await expect(panel).toHaveAttribute('data-outcome', 'win')
      await expect(elo).toHaveCount(0)
      await expect(p.getByTestId('result-reason')).not.toContainText(/resigned/i)
    } else {
      await expect(elo).toBeVisible({ timeout: 20_000 })
      await expect(panel).toHaveAttribute('data-outcome', 'loss')
      await expect(upload).toHaveCount(0)
    }
    await expect(p.getByText('Sign in to get a rating')).toHaveCount(0)
    expect(resigns).toHaveLength(1)
  })

  test(`fleet: a page that cannot make the record, ${want} in the log, then reloads: one resign beacon and a true note on the next load`, async ({ page }) => {
    test.setTimeout(540_000)
    await devSignIn(page, `norecord-reload-${want}`)
    const { page: p, failure } = await reachRecordFailure(page, want, mode, `reload-${want}`)
    expect(await p.evaluate(() => sessionStorage.getItem('beacons'))).toBeNull()
    await p.reload()
    await expect(p.getByTestId('fleet-page')).toBeVisible()
    const beacons = JSON.parse((await p.evaluate(() => sessionStorage.getItem('beacons'))) ?? '[]') as string[]
    expect(beacons.filter((u) => u.includes('/api/resign'))).toHaveLength(1)
    await expect(failure).toHaveCount(0)
    const note = p.getByTestId('fleet-left-line')
    if (want === 'won') {
      await expect(note).toHaveText('Reloading ended the match. Your last shot had already won it, so nothing was counted.')
    } else {
      await expect(note).toHaveText('Reloading ended the match. It counts as a loss.')
    }
  })
}

/** Tab B: an ordinary rated Stormglass match in the same signed-in context, one shot fired and left open. */
async function openSecondMatch(page: Page) {
  const b = await page.context().newPage()
  await b.setViewportSize({ width: 360, height: 740 })
  await b.goto('/play/stormglass?hold=0')
  await b.getByTestId('fleet-ready').click()
  await expect(b.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'you')
  await b.getByTestId('fleet-cell-0').click()
  await b.getByTestId('fleet-cell-0').click()
  await expect(b.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'you')
  return b
}

test('fleet: two tabs of one player: tab A won but could not save, tab B has an open match: B reloading reads the loss line, never A\'s win', async ({ page }) => {
  test.setTimeout(540_000)
  await devSignIn(page, 'twotab-b')
  const b = await openSecondMatch(page)
  const { page: a } = await reachRecordFailure(page, 'won', 'hunt', 'twotab-b-reload')
  await b.reload()
  await expect(b.getByTestId('fleet-left-line')).toHaveText('Reloading ended the match. It counts as a loss.')
  void a
})

test('fleet: two tabs of one player: tab A won but could not save, tab B then begins a match: A reloading still reads its own win line', async ({ page }) => {
  test.setTimeout(540_000)
  await devSignIn(page, 'twotab-a')
  const { page: a } = await reachRecordFailure(page, 'won', 'hunt', 'twotab-a-reload')
  // B's start clears the shared resign note; it must not clear A's note of its own win.
  await openSecondMatch(a)
  await a.reload()
  await expect(a.getByTestId('fleet-left-line')).toHaveText('Reloading ended the match. Your last shot had already won it, so nothing was counted.')
})
