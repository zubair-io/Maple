import { defineConfig } from '@playwright/test';
import profile from './playwright.auto-fit.config';
export default defineConfig({
  ...profile,
  testMatch: 'orientation.physical.ts',
  reporter: [['list'], ['json', { outputFile: 'test-results/orientation/results.json' }]],
});
