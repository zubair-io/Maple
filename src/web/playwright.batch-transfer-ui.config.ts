import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testMatch: 'batch-transfer-ui.spec.ts',
  workers: 1,
  timeout: 120000,
  use: {
    baseURL: 'http://localhost:4291',
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun x ng serve maple-syrup --port 4291',
    port: 4291,
    reuseExistingServer: false,
    timeout: 360000,
  },
});
