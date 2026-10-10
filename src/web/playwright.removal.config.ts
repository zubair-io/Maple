// Focused local experiment #3941 / #1472, requiring the actual pinned graph.
// Run after building maple-syrup; this is not a release/photo-quality gate.
import { defineConfig, devices } from '@playwright/test';
const port = process.env.MAPLE_E2E_REMOVAL_PORT ?? '4487';
export default defineConfig({
  testDir: './e2e/removal-experimental',
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: 'test-results/removal-experimental',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${port}`,
    actionTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'removal-cpu', use: { launchOptions: { args: ['--disable-webgpu'] } } },
    {
      name: 'removal-webgpu',
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
    command: `DIST=dist/maple-syrup/browser PORT=${port} bun scripts/serve-dist-coep.mjs`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
