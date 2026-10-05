import { expect, test } from '@playwright/test';

test('OPFS copy failure aborts the actual writer and preserves original bytes', async ({
  page,
}, testInfo) => {
  await page.goto('http://localhost:4520');
  await page.waitForFunction(() => Reflect.get(window, 'workflowUI')?.ready);
  const result = await page.evaluate(() => Reflect.get(window, 'workflowUI').opfsWriteFailure());
  await testInfo.attach('real-opfs-failure', {
    body: JSON.stringify(result),
    contentType: 'application/json',
  });
  expect(result.originalTypeError).toBe(true);
  expect(result.originalBytesPreserved).toBe(true);
  expect(result.aborted).toBe(true);
  expect(result.ownedDirectoryRemoved).toBe(true);
});

test('OPFS locked abort retains the actual copy and cleanup exceptions', async ({
  page,
}, testInfo) => {
  await page.goto('http://localhost:4520');
  await page.waitForFunction(() => Reflect.get(window, 'workflowUI')?.ready);
  const result = await page.evaluate(() =>
    Reflect.get(window, 'workflowUI').opfsWriteFailure(true),
  );
  await testInfo.attach('real-opfs-locked-abort', {
    body: JSON.stringify(result),
    contentType: 'application/json',
  });
  expect(result.bothFailuresPreserved).toBe(true);
  expect(result.originalBytesPreserved).toBe(true);
  expect(result.aborted).toBe(false);
});
