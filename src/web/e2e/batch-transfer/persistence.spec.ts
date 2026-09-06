import { expect, test } from '@playwright/test';
import type { BatchBrowserTest } from './main';
declare global {
  interface Window {
    batchTest: BatchBrowserTest;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.batchTest?.ready);
});
test('cancel, reload, and resume preserve the precise committed subset', async ({ page }) => {
  await page.evaluate(() => window.batchTest.configure({ stopAfter: 1 }));
  const cancelled = await page.evaluate(() => window.batchTest.start());
  expect(cancelled?.summary.applied).toEqual(['a']);
  expect(cancelled?.remaining).toBe(2);
  expect(await page.evaluate(() => window.batchTest.read('b'))).toBeNull();
  const a = await page.evaluate(() => window.batchTest.read('a'));
  await page.reload();
  await page.waitForFunction(() => window.batchTest?.ready);
  const record = await page.evaluate(() => window.batchTest.load());
  expect(record?.summary.cancelled).toBe(true);
  expect(record?.operation.directory).toBeDefined();
  const resumed = await page.evaluate((id) => window.batchTest.resume(id), record!.operation.id);
  expect(resumed?.summary.applied).toEqual(['a', 'b', 'c']);
  expect(await page.evaluate(() => window.batchTest.writes())).toBe(2);
  expect(await page.evaluate(() => window.batchTest.read('a'))).toBe(a);
});
test('a browser reload between sidecar commit and acknowledgment replays the frozen patch', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.batchTest.configure({ holdAfterWrite: true });
    void window.batchTest.start();
  });
  await page.waitForFunction(() => window.batchTest.writes() === 1);
  const before = await page.evaluate(() => window.batchTest.read('a'));
  await page.reload();
  await page.waitForFunction(() => window.batchTest?.ready);
  const record = await page.evaluate(() => window.batchTest.load());
  expect(record?.remaining).toBe(3);
  const result = await page.evaluate((id) => window.batchTest.resume(id), record!.operation.id);
  expect(result?.summary.applied).toEqual(['a', 'b', 'c']);
  expect(await page.evaluate(() => window.batchTest.read('a'))).toBe(before);
});
test('retry after reload touches only a failed photo and preserves the failure reason', async ({
  page,
}) => {
  await page.evaluate(() => window.batchTest.configure({ failId: 'b' }));
  const first = await page.evaluate(() => window.batchTest.start());
  expect(first?.summary.failed).toEqual([{ id: 'b', reason: 'The test photo is read-only.' }]);
  await page.reload();
  await page.waitForFunction(() => window.batchTest?.ready);
  const record = await page.evaluate(() => window.batchTest.load());
  const retry = await page.evaluate(
    (id) => window.batchTest.resume(id, true),
    record!.operation.id,
  );
  expect(retry?.summary.failed).toEqual([]);
  expect(await page.evaluate(() => window.batchTest.writes())).toBe(1);
});
test('another tab cannot run or delete an active batch', async ({ page, context }) => {
  await page.evaluate(() => {
    window.batchTest.configure({ holdAfterWrite: true });
    void window.batchTest.start();
  });
  await page.waitForFunction(() => window.batchTest.writes() === 1);
  const second = await context.newPage();
  await second.goto('/');
  await second.waitForFunction(() => window.batchTest?.ready);
  const record = await second.evaluate(() => window.batchTest.load());
  const rejected = await second.evaluate(async (id) => {
    try {
      await window.batchTest.resume(id);
      return '';
    } catch (error) {
      return String(error);
    }
  }, record!.operation.id);
  expect(rejected).toContain('another Maple tab');
  const deleteRejected = await second.evaluate(async (id) => {
    try {
      await window.batchTest.dismiss(id);
      return '';
    } catch (error) {
      return String(error);
    }
  }, record!.operation.id);
  expect(deleteRejected).toContain('another Maple tab');
});

test('interrupted failed-only retry resumes its saved selection before untouched pending photos', async ({
  page,
}) => {
  await page.evaluate(() => window.batchTest.configure({ failId: 'a', stopAfter: 1 }));
  const cancelled = await page.evaluate(() => window.batchTest.start());
  expect(cancelled?.summary.failed.map((failure) => failure.id)).toEqual(['a']);
  expect(cancelled?.remaining).toBe(2);
  await page.evaluate((id) => {
    window.batchTest.configure({ holdAfterWrite: true });
    void window.batchTest.resume(id, true);
  }, cancelled!.operation.id);
  await page.waitForFunction(() => window.batchTest.writes() === 1);
  await page.reload();
  await page.waitForFunction(() => window.batchTest?.ready);
  const record = await page.evaluate(() => window.batchTest.load());
  const recovered = await page.evaluate((id) => window.batchTest.resume(id), record!.operation.id);
  expect(recovered?.summary.applied).toEqual(['a']);
  expect(recovered?.remaining).toBe(2);
  expect(await page.evaluate(() => window.batchTest.read('b'))).toBeNull();
  expect(await page.evaluate(() => window.batchTest.read('c'))).toBeNull();
  const final = await page.evaluate((id) => window.batchTest.resume(id), record!.operation.id);
  expect(final?.summary.applied).toEqual(['a', 'b', 'c']);
});

test('a terminated worker rejects later requests promptly instead of leaving Resume hanging', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    window.batchTest.stopWorker();
    try {
      await window.batchTest.load();
      return '';
    } catch (error) {
      return String(error);
    }
  });
  expect(result).toContain('Batch paused when Maple closed');
});
