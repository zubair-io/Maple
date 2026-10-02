import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const corpus = JSON.parse(
  readFileSync(resolve('../../test-fixtures/workflow/contract-v1.json'), 'utf8'),
);
const xml = readFileSync(
  resolve('../../test-fixtures/local-adjustments/lightroom-group-add.xmp'),
  'utf8',
);
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Reflect.get(window, 'workflowTest')?.ready);
});
for (const [index, row] of corpus.entries())
  test(`real worker + atomic FS sidecar preserves corpus ${index} on edit and reopen`, async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ({ row, xml }) => Reflect.get(window, 'workflowTest').roundtrip(row, xml),
      { row, xml },
    );
    expect(result.reopened).toEqual(row);
    expect(result.retained).toEqual(row);
    expect(result.fresh).toEqual(row);
    expect(result.foreignMask).toBe(true);
    expect(result.exposure).toBe(1.25);
    expect(result.original).toEqual([1, 0, 255, 42]);
  });
test('unsupported persisted metadata rejects a save without changing real sidecar bytes', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ row, xml }) => Reflect.get(window, 'workflowTest').roundtrip(row, xml, true),
    { row: corpus[1], xml },
  );
  expect(result).toEqual({ rejected: true, unchanged: true, original: [1, 0, 255, 42] });
});
test('real WASM rejects malformed complete checkpoints and duplicate workflow', async ({
  page,
}) => {
  const invalid = {
    ...corpus[0],
    snapshots: [{ ...corpus[0].snapshots[0], adjustmentXmp: '<bad/>' }],
  };
  expect(
    await page.evaluate(
      async ({ row, xml }) => Reflect.get(window, 'workflowTest').rejects(row, xml),
      { row: invalid, xml },
    ),
  ).toBe(true);
});

test('an adjustment queued while the actual worker saves workflow retains every checkpoint', async ({
  page,
}) => {
  const row = corpus[1];
  const result = await page.evaluate(
    async ({ row, xml }) => Reflect.get(window, 'workflowTest').roundtrip(row, xml, false, true),
    { row, xml },
  );
  expect(result.reopened).toEqual(row);
  expect(result.retained).toEqual(row);
  expect(result.fresh).toEqual(row);
  expect(result.original).toEqual([1, 0, 255, 42]);
});

test('actual WASM captures exact complete checkpoints and resolves portable UUID siblings', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ row, xml }) => Reflect.get(window, 'workflowTest').checkpoints(row, xml),
    { row: corpus[1], xml },
  );
  expect(result).toEqual({
    basename: `photo.MOV.v${corpus[1].variantId}.xmp`,
    exact: true,
    unchangedModel: true,
    record: null,
    primary: 'photo.MOV.xmp',
    plain: true,
    invalidPath: true,
    invalidId: true,
    future: true,
    sidecarUnchanged: true,
    original: [1, 0, 255, 42],
  });
});
