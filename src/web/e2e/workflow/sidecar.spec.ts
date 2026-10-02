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

test('real browser storage discovers, branches, edits and reopens independent variants', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ row, xml }) => Reflect.get(window, 'workflowTest').variants(row, xml),
    { row: corpus[1], xml },
  );
  expect(result.listed).toEqual(result.expected);
  expect(result.retained).toEqual(corpus[1]);
  for (const key of [
    'oneCreated',
    'secondExposure',
    'missingRead',
    'missingWrite',
    'lostWrite',
    'futureWrite',
    'futureList',
    'futureUnchanged',
    'mismatched',
    'sourceUnchanged',
  ])
    expect(result[key]).toBe(true);
  expect(result.original).toEqual([1, 0, 255, 42]);
});

for (const [index, attrs] of [
  'crs:Temperature="5100"',
  'crs:Tint="-7"',
  'crs:Temperature="5100" crs:Tint="-7"',
].entries())
  test(`workflow namespace preserves foreign unstamped WB ${index} through actual WASM and storage`, async ({
    page,
  }) => {
    const input = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" ${attrs}/></rdf:RDF></x:xmpmeta>`;
    const result = await page.evaluate(
      async ({ row, input }) => Reflect.get(window, 'workflowTest').foreignWb(row, input),
      { row: corpus[0], input },
    );
    expect(result.before.wbScaleVersion).toBe(5);
    expect(result.after).toEqual(result.before);
    expect(result.workflow).toEqual(corpus[0]);
    expect(result.original).toEqual([1, 0, 255, 42]);
  });

test('real WASM semantic history and snapshot restore survive browser storage and reject stale state', async ({
  page,
}) => {
  const result = await page.evaluate(
    async (xml) => Reflect.get(window, 'workflowTest').mutations(xml),
    xml,
  );
  expect(result.snapshot).toEqual(result.expectedSnapshot);
  expect(result.historyCount).toBe(3);
  expect(result.editedExposure).toBe(1.25);
  expect(result.latest).toEqual(result.expectedRestore);
  for (const field of [
    'exact',
    'modelRestored',
    'stale',
    'duplicate',
    'forged',
    'futureReject',
    'diskUnchanged',
  ])
    expect(result[field], field).toBe(true);
  expect(result.original).toEqual([1, 0, 255, 42]);
});

for (const absent of [false, true])
  test(`confirmed browser writes have one winner across store instances (primary absent=${absent})`, async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ({ xml, absent }) => Reflect.get(window, 'workflowTest').confirmedRace(xml, absent),
      { xml, absent },
    );
    expect(result.winners).toBe(1);
    expect(result.stale).toBe(7);
    expect(result.count).toBe(1);
    expect(result.acknowledged).toBe(true);
    expect(result.retryCount).toBe(2);
    expect(result.retryAcknowledged).toBe(true);
    expect(result.original).toEqual([1, 0, 255, 42]);
  });
