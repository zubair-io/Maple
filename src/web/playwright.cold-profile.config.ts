import { defineConfig } from '@playwright/test';
import workflow from './playwright.workflow.config';
export default defineConfig({
  ...workflow,
  testMatch: 'cold-profile.physical.ts',
  reporter: [['list'], ['json', { outputFile: 'test-results/cold-profile/results.json' }]],
  webServer: Array.isArray(workflow.webServer)
    ? workflow.webServer.filter((server) => server.port === 4520)
    : workflow.webServer,
});
