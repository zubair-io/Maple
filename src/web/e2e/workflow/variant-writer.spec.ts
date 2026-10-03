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
for (const scenario of ['roundtrip', 'retry', 'missing', 'identity', 'queued'])
  test(`selected Hosted writer uses actual UUID sibling: ${scenario}`, async ({ page }) => {
    const result = await page.evaluate(
      async ({ input, scenario }) =>
        Reflect.get(window, 'workflowTest').variantWriter(input, scenario),
      { input, scenario },
    );
    expect(result.primaryUnchanged).toBe(true);
    expect(result.original).toEqual([1, 0, 255, 42]);
    if (scenario === 'queued') {
      expect(result.active).toBe('primary');
      expect(result.exposure).toBe(-0.5);
      expect(result.history).toEqual([1.25, -0.5]);
      return;
    }
    if (scenario === 'missing' || scenario === 'identity') {
      expect(result.rejected).toBe(true);
      expect(result.branchUnchanged).toBe(true);
      return;
    }
    expect(result.variantId).toBe(result.expectedId);
    expect(result.initialHistoryCount).toBe(1);
    expect(result.history).toEqual([
      { action: 'adjustment', exposure: 1.25 },
      { action: 'adjustment', exposure: -0.5 },
      { action: 'snapshot-restore', exposure: 2.5 },
    ]);
    expect(result.snapshots).toEqual([result.expectedSnapshot]);
    expect(result.savedSnapshot).toEqual(result.expectedSnapshot);
    expect(result.restoredExposure).toBe(2.5);
    expect(result.finalExposure).toBe(2.75);
    expect(result.foreign).toBe(true);
    expect(result.culling).toMatchObject({ rating: 3, flag: 'pick', keywords: ['kept'] });
    expect(result.reopened).toBe(true);
  });
