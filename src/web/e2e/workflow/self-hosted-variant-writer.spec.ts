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
for (const scenario of ['roundtrip', 'lost', 'missing'])
  test(`selected Self Hosted writer uses actual API/SQLite/IDB: ${scenario}`, async ({ page }) => {
    const result = await page.evaluate(
      async ({ input, scenario }) =>
        Reflect.get(window, 'workflowTest').selfHostedVariantWriter(input, scenario),
      { input, scenario },
    );
    expect(result.primaryUnchanged).toBe(true);
    expect(result.original).toEqual([1, 0, 255, 42]);
    if (scenario === 'missing') {
      expect(result.rejected).toBe(true);
      expect(result.pending).toBe(true);
      expect(result.branches).toBe(1);
      return;
    }
    expect(result.primaryChanges).toBe(0);
    expect(result.variantId).toBe(result.expectedId);
    expect(result.initialHistoryCount).toBe(1);
    expect(result.history).toEqual([
      { action: 'adjustment', exposure: 1.25 },
      { action: 'adjustment', exposure: -0.5 },
      { action: 'snapshot-restore', exposure: 1.25 },
    ]);
    expect(result.snapshots).toEqual([result.expectedSnapshot]);
    expect(result.exposure).toBe(1.25);
    expect(result.culling).toMatchObject({ rating: 3, flag: 'pick', keywords: ['kept'] });
    for (const field of ['foreign', 'modelIsolated', 'cacheExact', 'primaryCacheIsolated'])
      expect(result[field], field).toBe(true);
    expect(result.pending).toBe(false);
    expect(result.discovered).toEqual(['primary', result.expectedId].sort());
  });
