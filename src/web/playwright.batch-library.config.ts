import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/batch-library',
  testMatch: '**/*.spec.ts',
  testIgnore: '**/dist/**',
  workers: 1,
  timeout: 600_000,
  use: {
    baseURL: 'http://127.0.0.1:4283',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'bun x vite --config e2e/batch-library/vite.config.ts',
    url: 'http://127.0.0.1:4283',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
