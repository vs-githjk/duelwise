import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config.ts'

// The same e2e server and specs, run in WebKit as an iPhone 15 (the engine iOS Safari uses). It checks the phone layout and the no-jump rule
// on that engine; it cannot check iOS autoplay or screen-lock rules, which only a real device enforces.
//   bunx playwright test -c playwright.webkit.config.ts e2e/no-jump.spec.ts e2e/mobile.spec.ts
export default defineConfig({
  ...base,
  projects: [{ name: 'webkit-iphone-15', use: { ...devices['iPhone 15'] } }],
})
