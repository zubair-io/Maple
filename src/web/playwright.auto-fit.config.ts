import { defineConfig } from '@playwright/test';
import workflow from './playwright.workflow.config';
export default defineConfig({
  ...workflow,
  testMatch: 'auto-fit-status.physical.ts',
  reporter: [['list'], ['json', { outputFile: 'test-results/auto-fit/results.json' }]],
  webServer: Array.isArray(workflow.webServer)
    ? workflow.webServer
        .filter((server) => server.port === 4520)
        .map((server) => ({ ...server, timeout: 120000 }))
    : workflow.webServer,
});
