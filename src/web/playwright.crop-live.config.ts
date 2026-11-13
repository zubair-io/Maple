import { defineConfig } from '@playwright/test';
import profile from './playwright.auto-fit.config';
export default defineConfig({
  ...profile,
  testMatch: 'crop-live.physical.ts',
  reporter: [['list'], ['json', { outputFile: 'test-results/crop-live/results.json' }]],
});
