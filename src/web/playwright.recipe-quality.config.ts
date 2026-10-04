import { defineConfig } from '@playwright/test';
import workflow from './playwright.workflow.config';
export default defineConfig({
  ...workflow,
  testMatch: 'recipe-quality.physical.ts',
  reporter: [['list'], ['json', { outputFile: 'test-results/recipe-quality/results.json' }]],
  webServer: Array.isArray(workflow.webServer)
    ? workflow.webServer
        .filter((server) => server.port === 4520)
        .map((server) => ({
          ...server,
          command: './node_modules/.bin/ng serve workflow-qualification --port 4522',
          port: 4522,
          timeout: 120000,
        }))
    : workflow.webServer,
});
