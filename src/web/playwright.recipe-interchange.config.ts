import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/recipe-interchange',
  testMatch: 'interchange.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [['list'], ['json', { outputFile: 'test-results/recipe-interchange/results.json' }]],
  use: {
    baseURL: 'http://localhost:4530',
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
  webServer: {
    command: './node_modules/.bin/vite --config e2e/recipe-interchange/vite.config.ts',
    port: 4530,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
