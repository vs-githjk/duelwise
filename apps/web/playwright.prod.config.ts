import { defineConfig, devices } from '@playwright/test'
import { webPort } from './port.ts'

const port = webPort()

/** Production-build e2e: timing claims are only meaningful against `vite build`, never the dev server. */
export default defineConfig({
  testDir: './e2e-prod',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure', extraHTTPHeaders: { 'x-dw-test': '1' } },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun run build && bun scripts/serve-prod.ts',
    cwd: import.meta.dirname,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
})
