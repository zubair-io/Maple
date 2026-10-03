import { expect, test } from '@playwright/test';

test('actual RAW branch pixels reuse bounded bitmaps and reject stale identities', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => Reflect.get(window, 'workflowTest')?.ready);
  const result = await page.evaluate(async () =>
    Reflect.get(window, 'workflowTest').variantPreviewCache(),
  );
  expect(result.rawLength).toBeGreaterThan(8000);
  for (const key of [
    'renderedDifferent',
    'exportDifferent',
    'staleXML',
    'staleBytes',
    'staleViewport',
    'reuseExactBitmap',
    'oldestClosed',
    'allClosed',
    'primaryUnchanged',
    'originalUnchanged',
  ])
    expect(result[key], key).toBe(true);
});
