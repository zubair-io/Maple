import { defineConfig, devices } from '@playwright/test';

const configOnly = process.env.MAPLE_E2E_CONFIG_ONLY === '1';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'production/**/*.spec.ts',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  outputDir: 'test-results/production-chrome',
  globalTeardown: configOnly ? undefined : './e2e/support/production-global-teardown.ts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'chrome-hosted',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        baseURL: 'http://127.0.0.1:4400',
      },
    },
    {
      name: 'chrome-self-hosted',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        baseURL: 'http://127.0.0.1:4401',
      },
    },
  ],
  webServer: configOnly
    ? undefined
    : {
        command: 'bun scripts/serve-production-e2e.ts',
        url: 'http://127.0.0.1:4400',
        reuseExistingServer: false,
        timeout: 600_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
