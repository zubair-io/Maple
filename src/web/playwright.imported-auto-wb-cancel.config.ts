import { defineConfig, devices } from '@playwright/test';
// #5923 local measurement: the real render worker in Chrome with WebGPU (headless
// needs the flags below on macOS), on a cross-origin-isolated page and on one
// without COOP/COEP, where the estimate cannot be cancelled.
const server = (isolated: boolean, port: number) => ({
  command: `MAPLE_IMPORTED_WB_ISOLATED=${isolated ? 1 : 0} bun x vite --config e2e/imported-auto-wb-cancel/vite.config.ts`,
  port,
  reuseExistingServer: false,
  timeout: 30000,
});

export default defineConfig({
  testDir: './e2e/imported-auto-wb-cancel',
  workers: 1,
  timeout: 600000,
  use: {
    ...devices['Desktop Chrome'],
    launchOptions: { args: ['--enable-unsafe-webgpu', '--use-angle=metal'] },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'isolated', use: { baseURL: 'http://localhost:4285' } },
    { name: 'not-isolated', use: { baseURL: 'http://localhost:4286' } },
  ],
  webServer: [server(true, 4285), server(false, 4286)],
});
