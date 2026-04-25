/**
 * Plan 3 M2.1 verification spikes — dedicated Playwright config.
 *
 * Drives the throwaway probe at `./probe.html` across Chromium, Firefox, and
 * WebKit. The probe is a static HTML file loaded via `file://`, so no dev
 * server is needed (the workspace's main `playwright.config.ts` is for the
 * Angular dev-server-backed e2e suite).
 *
 * Usage:
 *
 *     cd src/web && npx playwright test \
 *       projects/maple-common/src/lib/webgl/spikes/run-spikes.playwright.ts \
 *       --config=projects/maple-common/src/lib/webgl/spikes/playwright.config.ts
 *
 * Output: `results-{chromium,firefox,webkit}.json` written into the spikes/
 * directory, plus a tabular console summary.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'run-spikes.playwright.ts',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    trace: 'retain-on-failure',
    video: 'off',
    // Probe is loaded via file://, no baseURL needed.
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // No webServer block — probe is a static file://.
});
