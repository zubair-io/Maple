import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ImportedWbCancelHarness } from './main';

declare global {
  interface Window {
    importedWbCancel: ImportedWbCancelHarness;
  }
}

// #5923 local gate: needs WebGPU and the gitignored RAW fixtures, so it is
// opt-in (MAPLE_PERF=1) and soft-skips without them, like the slider bench.
const SLIDER_HARD_LIMIT_MS = 50;
const fixtures = (process.env['MAPLE_IMPORTED_WB_FIXTURES'] ?? 'test_0006.DNG').split(',');

for (const name of fixtures) {
  const path = resolve(process.cwd(), '../../test-fixtures/raws', name);
  test(`${name}: a slider render during the imported Auto WB estimate is not held by it`, async ({
    page,
  }) => {
    test.skip(process.env['MAPLE_PERF'] !== '1', 'Set MAPLE_PERF=1 to run this measurement.');
    test.skip(!existsSync(path), `${path} is missing (RAW fixtures are gitignored).`);
    test.setTimeout(300_000);
    await page.route('**/fixture.raw', (route) => route.fulfill({ path }));
    await page.goto('/');
    await page.waitForFunction(() => window.importedWbCancel?.ready);
    const result = await page.evaluate(
      (delays) => window.importedWbCancel.run('/fixture.raw', delays),
      [20, 150, 400, 800],
    );
    console.info(`#5923 ${name}: ${JSON.stringify(result)}`);
    for (const trial of result.trials) {
      expect(trial.samePair).toBe(true);
      if (trial.waitedWithoutCancelMs > 0) {
        expect(trial.attempts).toBe(2);
        expect(trial.tickMs).toBeLessThan(SLIDER_HARD_LIMIT_MS);
      }
    }
  });
}
