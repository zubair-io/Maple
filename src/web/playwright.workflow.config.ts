import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/workflow',
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [['list'], ['json', { outputFile: 'test-results/workflow/results.json' }]],
  use: {
    baseURL: 'http://localhost:4518',
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: './node_modules/.bin/ng serve workflow-qualification',
      port: 4520,
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: './node_modules/.bin/vite --config e2e/workflow/vite.config.ts',
      port: 4518,
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: 'bun ../api/tests/browser/workflow-server.ts',
      url: 'http://127.0.0.1:4519/workflow-fixture/health',
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
