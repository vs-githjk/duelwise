import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config.ts'

/**
 * Real WebKit (the engine of every iPhone browser) with the iPhone 15 profile. Not part of the default run; pick the specs:
 *   PORT=<free port> bunx playwright test -c playwright.webkit.config.ts e2e/reload.spec.ts
 */
export default defineConfig({
  ...base,
  projects: [{ name: 'webkit-iphone', use: { ...devices['iPhone 15'] } }],
})
