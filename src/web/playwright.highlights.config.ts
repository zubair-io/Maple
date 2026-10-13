import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: 'highlights-slider.perf.spec.ts',
  use: {
    ...base.use,
    baseURL: 'http://localhost:4595',
    channel: 'chrome',
    launchOptions: {
      args: [
        '--enable-unsafe-webgpu',
        ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
      ],
    },
  },
  webServer: {
    command: 'bun x ng serve maple-syrup --port 4595',
    port: 4595,
    reuseExistingServer: false,
    timeout: 180000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  reporter: [['list'], ['json', { outputFile: 'test-results/highlights/results.json' }]],
});
