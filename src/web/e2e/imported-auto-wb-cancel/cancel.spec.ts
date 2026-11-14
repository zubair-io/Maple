import { existsSync, realpathSync } from 'node:fs';
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
const DELAYS_MS = [20, 150, 400, 800];
const REPEATS = Number(process.env['MAPLE_IMPORTED_WB_REPEATS'] ?? 5);
const fixtures = (process.env['MAPLE_IMPORTED_WB_FIXTURES'] ?? 'test_0006.DNG').split(',');

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const summary = (values: number[]) =>
  `p50 ${percentile(values, 50).toFixed(1)} ms, p95 ${percentile(values, 95).toFixed(1)} ms, ` +
  `max ${Math.max(...values).toFixed(1)} ms (n=${values.length})`;

for (const name of fixtures) {
  const path = resolve(process.cwd(), '../../test-fixtures/raws', name);
  test(`${name}: a slider render during the imported Auto WB estimate`, async ({ page }) => {
    test.skip(process.env['MAPLE_PERF'] !== '1', 'Set MAPLE_PERF=1 to run this measurement.');
    test.skip(!existsSync(path), `${path} is missing (RAW fixtures are gitignored).`);
    const isolated = test.info().project.name === 'isolated';
    await page.goto('/');
    await page.waitForFunction(() => window.importedWbCancel?.ready);
    const delays = Array.from({ length: REPEATS }, () => DELAYS_MS).flat();
    const result = await page.evaluate(
      ([url, requested]) => window.importedWbCancel.run(url, requested),
      [`/@fs${realpathSync(path)}`, delays] as const,
    );
    const during = result.trials.filter((trial) => trial.waitedWithoutCancelMs > 0);
    const project = test.info().project.name;
    console.info(`#5923 ${project} ${name}: ${JSON.stringify(result)}`);
    console.info(
      `#5923 ${project} ${name}: estimate ${result.estimateMs.toFixed(0)} ms; ` +
        `idle ticks ${summary(result.idleTicks)}; ticks during the estimate ${summary(
          during.map((trial) => trial.tickMs),
        )}; settled ${summary(during.map((trial) => trial.settledAfterMs))} after the first ask`,
    );

    expect(result.isolated).toBe(isolated);
    expect(during.length).toBeGreaterThan(0);
    for (const trial of result.trials) expect(trial.samePair).toBe(true);
    for (const trial of during) {
      if (isolated) {
        expect(trial.attempts).toBe(2);
        expect(trial.tickMs).toBeLessThan(SLIDER_HARD_LIMIT_MS);
      } else {
        expect(trial.attempts).toBe(1);
        expect(trial.tickMs).toBeGreaterThan(trial.waitedWithoutCancelMs / 2);
      }
    }
  });
}
