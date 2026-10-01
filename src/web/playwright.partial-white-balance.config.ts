import { defineConfig, devices } from '@playwright/test';
// Local hardware gate (#3434): requires WebGPU, rather than silently using WASM CPU.
export default defineConfig({
  testDir: './e2e/partial-white-balance',
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:4283',
    ...devices['Desktop Chrome'],
    launchOptions: { args: ['--enable-unsafe-webgpu', '--use-angle=metal'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: './node_modules/.bin/vite --config e2e/partial-white-balance/vite.config.ts',
    port: 4283,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
