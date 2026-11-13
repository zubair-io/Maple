import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/removal-self-hosted',
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: 'test-results/removal-self-hosted',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4203',
    actionTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'server-removal-cpu', use: { launchOptions: { args: ['--disable-webgpu'] } } },
    {
      name: 'server-removal-webgpu',
      use: {
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'bun scripts/serve-removal-self-hosted-e2e.ts',
    url: 'http://127.0.0.1:4203',
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
