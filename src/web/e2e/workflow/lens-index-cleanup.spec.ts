import { expect, test } from '@playwright/test';

test('Hosted cleanup waits for its real in-flight OPFS index stream', async ({ page }) => {
  await page.goto('http://localhost:4520');
  await page.waitForFunction(() => Reflect.get(window, 'workflowUI')?.ready);
  const result = await page.evaluate(() =>
    Reflect.get(window, 'workflowUI').lensIndexCleanupBoundary(),
  );
  expect(result.removalBeforeClose).toBe(false);
  expect(result.cleanupSucceeded).toBe(true);
  expect(result.realIndexStreamClosed).toBe(true);
});
