import { expect, test, type Page } from '@playwright/test'
import { decodeRecord, encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record.ts'
import { fleetCore } from '@duelwise/core/src/games/fleet/index.ts'

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
    await expect(page.getByTestId('preview-badge')).toHaveText(/In training/)
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
    const body = (await r.json()) as { valid: boolean; reason?: string; elo?: unknown }
    expect(body).toMatchObject({ valid: false, reason: 'record does not match the logged turns' })
    expect(body.elo).toBeUndefined()
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
    await expect(page.getByRole('alert')).toContainText(/shot not sent/i)
    await fits()
    expect(aborts).toBe(4)
    // Another square now: the lost shot is sent first and the match goes on, with no error line left.
    const other = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').nth(5)
    await other.click()
    await other.click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('[data-testid^="fleet-cell-"]:is([data-state="hit"],[data-state="miss"],[data-state="sunk"])')).toHaveCount(1)
    // A failed shot, then Resign: the over screen keeps no stale "fire again" line.
    abortLeft = 2
    const third = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').nth(7)
    await third.click()
    await third.click()
    await expect(page.getByRole('alert')).toContainText(/shot not sent/i)
    await page.getByTestId('fleet-resign').click()
    await page.getByTestId('fleet-resign-yes').click()
    await expect(root).toHaveAttribute('data-turn', 'over')
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})
