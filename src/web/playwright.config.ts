import { defineConfig, devices } from '@playwright/test';

// Playwright runs the Angular dev server against the maple-hosted project and
// executes the e2e specs in src/web/e2e/. Chromium only — the RAW decode path
// requires crossOriginIsolated (COOP + COEP headers) which the ng-serve
// config enables; Safari and Firefox decode paths are covered by unit tests.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: 'http://localhost:4200',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun x ng serve maple-hosted --port 4200',
    port: 4200,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
