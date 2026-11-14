import { defineConfig, devices } from '@playwright/test';
// #5923 local measurement: the real render worker in cross-origin-isolated Chrome
// with WebGPU (headless needs the flags below on macOS).
export default defineConfig({
  testDir: './e2e/imported-auto-wb-cancel',
  workers: 1,
  timeout: 300000,
  use: {
    baseURL: 'http://localhost:4285',
    ...devices['Desktop Chrome'],
    launchOptions: { args: ['--enable-unsafe-webgpu', '--use-angle=metal'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun x vite --config e2e/imported-auto-wb-cancel/vite.config.ts',
    port: 4285,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
