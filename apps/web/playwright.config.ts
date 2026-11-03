import { defineConfig, devices } from '@playwright/test'
import { webPort } from './port.ts'

const port = webPort()
// Specs start with every How to play guide marked seen, so the first-visit dialog does not cover Start match, and with the path unlocked.
// e2e/how-to-play.spec.ts clears this to test the first visit.
const guidesSeen = {
  cookies: [],
  origins: [{
    origin: `http://localhost:${port}`,
    localStorage: [
      ...['chess', 'four', 'holdem', 'word', 'fighter', 'arena', 'fleet'].map((game) => ({ name: `duelwise.how-to-play.${game}`, value: 'seen' })),
      // Every stop of the adventure path is open (the owner escape hatch, same as ?any=1), so a spec can pick any level.
      // e2e/path.spec.ts clears it to test the locks.
      { name: 'duelwise.any', value: '1' },
      // The one-time welcome (name or skip) is already done, so a spec lands on the game picker. e2e/landing.spec.ts clears it to test the first visit.
      { name: 'duelwise.welcomed', value: '1' },
    ],
  }],
}

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  snapshotPathTemplate: '{testDir}/__screens__/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  // Every e2e request carries the test marker, so the owner page counts these runs as test traffic.
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure', storageState: guidesSeen, extraHTTPHeaders: { 'x-dw-test': '1' } },
  // Playwright starts Chromium with --mute-audio; Vidyut wants to hear that a run is going, so the flag is dropped (also for the WebKit config, which spreads this one).
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { ignoreDefaultArgs: ['--mute-audio'] } } }],
  webServer: {
    command: `bun run dev`,
    cwd: import.meta.dirname,
    url: `http://localhost:${port}`,
    // DUELWISE_DB=memory: the e2e server never opens <common root>/.data/pglite (Vidyut's dev database).
    env: { PORT: String(port), DUELWISE_DB: 'memory', DEV_LOGIN: '1', OWNER_EMAILS: 'eowner@dev.invalid', DUELWISE_AGENT_CHECK: 'off' },
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
