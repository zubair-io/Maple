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
  webServer: {
    command: './node_modules/.bin/vite --config e2e/workflow/vite.config.ts',
    port: 4518,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
