import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/batch-transfer',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:4281',
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun x vite --config e2e/batch-transfer/vite.config.ts',
    port: 4281,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
