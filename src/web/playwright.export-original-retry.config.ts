import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/workflow',
  testMatch: 'self-hosted-export-retry.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [['list'], ['json', { outputFile: 'test-results/export-original-retry/results.json' }]],
  use: {
    baseURL: 'http://localhost:4518',
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: './node_modules/.bin/vite --config e2e/workflow/vite.config.ts',
      port: 4518,
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: 'bun ../api/tests/browser/export-retry-server.ts',
      url: 'http://127.0.0.1:4519/workflow-fixture/health',
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
