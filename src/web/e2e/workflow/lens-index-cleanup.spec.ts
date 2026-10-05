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

test('A failed actual writer cannot finish index flush before another real stream closes', async ({
  page,
}, testInfo) => {
  await page.goto('http://localhost:4520');
  await page.waitForFunction(() => Reflect.get(window, 'workflowUI')?.ready);
  const result = await page.evaluate(() =>
    Reflect.get(window, 'workflowUI').lensIndexCleanupBoundary(true),
  );
  await testInfo.attach('real-opfs-concurrent-failure', {
    body: JSON.stringify(result),
    contentType: 'application/json',
  });
  expect(result.flushFinishedBeforeIndexClose).toBe(false);
  expect(result.originalTypeError).toBe(true);
  expect(result.failurePreserved).toBe(true);
  expect(result.originalBytesPreserved).toBe(true);
  expect(result.realIndexStreamClosed).toBe(true);
});
