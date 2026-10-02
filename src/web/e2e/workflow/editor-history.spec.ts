import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const foreign =
  '<vendor:Audit xmlns:vendor="urn:maple:test:opaque"> exact &amp; kept </vendor:Audit>';
const input = readFileSync(
  resolve('../../test-fixtures/local-adjustments/lightroom-group-add.xmp'),
  'utf8',
).replace('<crs:MaskGroupBasedCorrections>', foreign + '\n<crs:MaskGroupBasedCorrections>');
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Reflect.get(window, 'workflowTest')?.ready);
});
for (const scenario of [
  'rapid',
  'preview',
  'retry',
  'retry-flush',
  'navigationRetry',
  'scope',
  'future',
  'identity',
  'concurrent',
  'compaction',
]) {
  test(`actual editor semantic history: ${scenario}`, async ({ page }) => {
    const result = await page.evaluate(
      async ({ input, scenario }) =>
        Reflect.get(window, 'workflowTest').editorHistory(input, scenario),
      { input, scenario },
    );
    if (scenario === 'future' || scenario === 'identity') {
      expect(result).toEqual({ rejected: true, unchanged: true });
      return;
    }
    expect(result.original).toEqual([1, 0, 255, 42]);
    expect(result.foreign).toBe(true);
    expect(result.checkpointHasForeign).toBe(true);
    expect(result.reopened).toEqual(result.workflow);
    if (scenario === 'rapid') {
      expect(result.values).toEqual([0.25, 0.75, 1.25, 0.75, 1.25]);
      expect(result.workflow.history.map((item: { action: string }) => item.action)).toEqual([
        'adjustment',
        'adjustment',
        'adjustment',
        'undo',
        'redo',
      ]);
      expect(new Set(result.workflow.history.map((item: { id: string }) => item.id)).size).toBe(5);
      expect(result.exposure).toBe(1.25);
    } else if (scenario === 'preview') {
      expect(result.workflow).toBeNull();
      expect(result.exposure).toBe(0.75);
    } else if (['retry', 'navigationRetry', 'retry-flush', 'scope'].includes(scenario)) {
      const expected = {
        retry: { values: [1.25], exposure: 2.5 },
        navigationRetry: { values: [1.25], exposure: 1.25 },
        'retry-flush': { values: [1.25], exposure: 1.25 },
        scope: { values: [0.5], exposure: 0.5 },
      };
      expect(result.values).toEqual(expected[scenario as keyof typeof expected].values);
      expect(result.exposure).toBe(expected[scenario as keyof typeof expected].exposure);
      if (scenario === 'retry-flush') expect(result.phase).toBe('saved');
    } else if (scenario === 'concurrent') {
      expect(result.values.toSorted()).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
      expect(result.workflow.history).toHaveLength(8);
    } else {
      expect(result.values).toEqual(Array.from({ length: 32 }, (_, index) => (index + 9) / 10));
      expect(result.workflow.snapshots).toHaveLength(1);
      expect(result.exposure).toBe(4);
    }
  });
}
