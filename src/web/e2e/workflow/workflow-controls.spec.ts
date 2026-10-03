import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const opaque =
  '<vendor:Audit xmlns:vendor="urn:maple:test:opaque"> exact &amp; kept </vendor:Audit>';
const input = readFileSync(
  resolve('../../test-fixtures/local-adjustments/lightroom-group-add.xmp'),
  'utf8',
).replace('<crs:MaskGroupBasedCorrections>', opaque + '\n<crs:MaskGroupBasedCorrections>');
const state = (page: Page) => page.evaluate(async () => Reflect.get(window, 'workflowUI').state());
const open = (page: Page) =>
  page.getByRole('button', { name: 'Snapshots and history', exact: true }).click();
async function save(page: Page, name: string) {
  await page.getByRole('button', { name: 'Save snapshot', exact: true }).click();
  await page.getByRole('textbox', { name: 'Snapshot name' }).fill(name);
  await page
    .getByRole('dialog', { name: 'Snapshot name' })
    .getByRole('button', { name: 'Save snapshot', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: `Restore Snapshot: ${name}`, exact: true }),
  ).toBeVisible();
}
async function restore(page: Page, name: string) {
  await page.getByRole('button', { name: `Restore Snapshot: ${name}`, exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Restore this version?' })
    .getByRole('button', { name: 'Restore', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Snapshots and history', exact: true }),
  ).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await page.goto('http://localhost:4520');
  await page.waitForFunction(() => Reflect.get(window, 'workflowUI')?.ready);
});
test.afterEach(async ({ page }) => {
  await page.evaluate(async () => Reflect.get(window, 'workflowUI')?.dispose());
});
for (const backend of ['hosted', 'self-hosted'] as const) {
  test(`${backend}: restoring an unchanged self-closing checkpoint records no action`, async ({
    page,
  }) => {
    const input =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="0" crs:Temperature="6500" crs:Tint="0"/></rdf:RDF></x:xmpmeta>';
    await page.evaluate(
      async ({ input, backend }) => Reflect.get(window, 'workflowUI').mount(input, backend),
      { input, backend },
    );
    await open(page);
    await save(page, 'Unchanged');
    const before = await state(page);
    await restore(page, 'Unchanged');
    const after = await state(page);
    expect(after.xml).toBe(before.xml);
    expect(after.workflow.history).toEqual([]);
    expect(after.undoCount).toBe(0);
  });
  test(`${backend}: navigation during Undo cannot retain a retry in the new binding`, async ({
    page,
  }) => {
    await page.evaluate(
      async ({ input, backend }) => Reflect.get(window, 'workflowUI').mount(input, backend),
      { input, backend },
    );
    await open(page);
    await save(page, 'Original');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').edit(1.25));
    await open(page);
    await restore(page, 'Original');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').blockPublication());
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'workflowUI').status().busy))
      .toBe(true);
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').navigate());
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').releasePublication());
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'workflowUI').status().busy))
      .toBe(false);
    const result = await page.evaluate(async () =>
      Reflect.get(window, 'workflowUI').navigationResult(),
    );
    expect(result.model.exposure).toBe(9);
    expect(result.undoCount).toBe(0);
    expect(result.replayRetained).toBe(false);
    expect(result.nextUnchanged).toBe(true);
    expect(result.old).toContain('<papp:Action>undo');
  });
  test(`${backend}: navigation during a blocked restore cannot apply to the replacement photo`, async ({
    page,
  }) => {
    await page.evaluate(
      async ({ input, backend }) => Reflect.get(window, 'workflowUI').mount(input, backend),
      { input, backend },
    );
    await open(page);
    await save(page, 'Original');
    const original = await state(page);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').edit(1.25));
    await open(page);
    await page.getByRole('button', { name: 'Restore Snapshot: Original', exact: true }).click();
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').blockPublication());
    await page
      .getByRole('dialog', { name: 'Restore this version?' })
      .getByRole('button', { name: 'Restore', exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'workflowUI').status().busy))
      .toBe(true);
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').navigate());
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').releasePublication());
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'workflowUI').status().busy))
      .toBe(false);
    const result = await page.evaluate(async () =>
      Reflect.get(window, 'workflowUI').navigationResult(),
    );
    expect(result.model.exposure).toBe(9);
    expect(result.undoCount).toBe(0);
    expect(result.nextUnchanged).toBe(true);
    expect(result.old).toContain('snapshot-restore');
    expect(original.original).toEqual([1, 0, 255, 42]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
  test(`${backend}: actual controls persist complete snapshots, restore, Undo, Redo and reopen`, async ({
    page,
  }) => {
    await page.evaluate(
      async ({ input, backend }) => Reflect.get(window, 'workflowUI').mount(input, backend),
      { input, backend },
    );
    await open(page);
    await save(page, 'Original');
    const original = await state(page);
    expect(original.workflow.snapshots).toHaveLength(1);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').edit(1.25));
    const developed = await state(page);
    const changed = developed.xml.replace('exact &amp; kept', 'foreign &amp; changed');
    await page.evaluate(async (xml) => Reflect.get(window, 'workflowUI').replace(xml), changed);
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').cull());
    const before = await state(page);
    await open(page);
    await page.getByRole('button', { name: 'Restore Snapshot: Original', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Restore this version?' })
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    expect((await state(page)).xml).toBe(before.xml);
    await restore(page, 'Original');
    const restored = await state(page);
    expect(restored.checkpoint).toBe(original.workflow.snapshots[0].adjustmentXmp);
    expect(restored.last).toBe('variant');
    expect(restored.undoCount).toBe(2);
    expect(restored.asset.rating).toBe(original.asset.rating);
    expect(restored.asset.flag).toBe(original.asset.flag);
    expect(restored.asset.colorLabel).toBe(original.asset.colorLabel);
    expect(restored.asset.keywords).toEqual(original.asset.keywords);
    expect(restored.original).toEqual([1, 0, 255, 42]);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await state(page)).checkpoint).toBe(before.checkpoint);
    expect((await state(page)).undoCount).toBe(1);
    expect((await state(page)).asset.keywords).toEqual(['authored-after-snapshot']);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(async () => (await state(page)).checkpoint).toBe(restored.checkpoint);
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').edit(2));
    const edited = await state(page);
    expect(edited.xml).toContain(opaque);
    expect(edited.model.exposure).toBe(2);
    expect(edited.workflow.snapshots).toEqual(original.workflow.snapshots);
    expect(edited.asset.keywords).toEqual(original.asset.keywords);
    expect(edited.checkpoint).not.toContain('authored-after-snapshot');
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').reopen());
    await open(page);
    await expect(
      page.getByRole('button', { name: 'Restore Snapshot: Original', exact: true }),
    ).toBeVisible();
    const reopened = await state(page);
    expect(reopened.workflow).toEqual(edited.workflow);
    expect(reopened.model.exposure).toBe(2);
    expect(reopened.original).toEqual([1, 0, 255, 42]);
  });

  test(`${backend}: foreign-only restore records one action and failed Undo retains it`, async ({
    page,
  }) => {
    await page.evaluate(
      async ({ input, backend }) => Reflect.get(window, 'workflowUI').mount(input, backend),
      { input, backend },
    );
    await open(page);
    await save(page, 'Opaque metadata');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const initial = await state(page);
    await page.evaluate(
      async (xml) => Reflect.get(window, 'workflowUI').replace(xml),
      initial.xml.replace('exact &amp; kept', 'foreign &amp; changed'),
    );
    const before = await state(page);
    expect(before.model).toEqual(initial.model);
    await open(page);
    await restore(page, 'Opaque metadata');
    const restored = await state(page);
    expect(restored.undoCount).toBe(1);
    expect(restored.checkpoint).toBe(initial.workflow.snapshots[0].adjustmentXmp);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const saved = await page.evaluate(async () => Reflect.get(window, 'workflowUI').obstruct());
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'workflowUI').status().error))
      .not.toBeNull();
    await page.evaluate(async (xml) => Reflect.get(window, 'workflowUI').repair(xml), saved);
    expect((await state(page)).undoCount).toBe(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await state(page)).checkpoint).toBe(before.checkpoint);
    expect((await state(page)).undoCount).toBe(0);
  });

  test(`${backend}: stale history rejects restore, refresh keeps the selected action available`, async ({
    page,
  }) => {
    await page.evaluate(
      async ({ input, backend }) => Reflect.get(window, 'workflowUI').mount(input, backend),
      { input, backend },
    );
    await open(page);
    await save(page, 'Original');
    const loaded = await state(page);
    await page.getByRole('button', { name: 'Restore Snapshot: Original', exact: true }).click();
    await page.evaluate(
      async (xml) => Reflect.get(window, 'workflowUI').replace(xml),
      loaded.xml.replace('exact &amp; kept', 'external &amp; edit'),
    );
    const external = await state(page);
    await page
      .getByRole('dialog', { name: 'Restore this version?' })
      .getByRole('button', { name: 'Restore', exact: true })
      .click();
    await expect(page.getByRole('dialog', { name: 'Restore this version?' })).toContainText(
      /changed|conflict|409/i,
    );
    expect((await state(page)).xml).toBe(external.xml);
    expect((await state(page)).undoCount).toBe(0);
    await page
      .getByRole('dialog', { name: 'Restore this version?' })
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await restore(page, 'Original');
    expect((await state(page)).undoCount).toBe(1);
    expect((await state(page)).original).toEqual([1, 0, 255, 42]);
  });

  test(`${backend}: first snapshot creates an absent primary and accessible phone dialogs`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(
      async (backend) => Reflect.get(window, 'workflowUI').mount(null, backend),
      backend,
    );
    await open(page);
    await expect(
      page.getByRole('dialog', { name: 'Snapshots and history', exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: `/tmp/maple-4060-${backend}-phone-before.png` });
    await save(page, 'First snapshot');
    await page.screenshot({ path: `/tmp/maple-4060-${backend}-phone-after.png` });
    const saved = await state(page);
    expect(saved.workflow.snapshots).toHaveLength(1);
    expect(saved.workflow.history).toHaveLength(0);
    expect(saved.original).toEqual([1, 0, 255, 42]);
    const panel = page.getByRole('dialog', { name: 'Snapshots and history', exact: true });
    const box = await panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await panel.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(panel.getByRole('button', { name: 'Save snapshot', exact: true })).toBeFocused();
    await panel.getByRole('button', { name: 'Save snapshot', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Snapshots and history', exact: true }),
    ).toBeFocused();
  });
}

test('Self Hosted actual snapshot/restore/Undo acknowledge lost accepted replies once', async ({
  page,
}) => {
  await page.evaluate(
    async (input) => Reflect.get(window, 'workflowUI').mount(input, 'self-hosted'),
    input,
  );
  await open(page);
  await page.getByRole('button', { name: 'Save snapshot', exact: true }).click();
  await page.getByRole('textbox', { name: 'Snapshot name' }).fill('Accepted snapshot');
  await page.evaluate(async () => Reflect.get(window, 'workflowUI').loseResponse());
  const prompt = page.getByRole('dialog', { name: 'Snapshot name' });
  await prompt.getByRole('button', { name: 'Save snapshot', exact: true }).click();
  await expect(prompt).toContainText('lost the accepted');
  const accepted = await state(page);
  expect(accepted.workflow.snapshots).toHaveLength(1);
  await prompt.getByRole('button', { name: 'Save snapshot', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Restore Snapshot: Accepted snapshot', exact: true }),
  ).toBeVisible();
  expect((await state(page)).workflow.snapshots).toEqual(accepted.workflow.snapshots);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(async () => Reflect.get(window, 'workflowUI').edit(1.25));
  const before = await state(page);
  await open(page);
  await page
    .getByRole('button', { name: 'Restore Snapshot: Accepted snapshot', exact: true })
    .click();
  await page.evaluate(async () => Reflect.get(window, 'workflowUI').loseResponse());
  const dialog = page.getByRole('dialog', { name: 'Restore this version?' });
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(dialog).toContainText('lost the accepted');
  const published = await state(page);
  expect(published.undoCount).toBe(1);
  expect(published.workflow.history).toHaveLength(2);
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Snapshots and history', exact: true }),
  ).toBeVisible();
  expect((await state(page)).workflow.history).toEqual(published.workflow.history);
  expect((await state(page)).undoCount).toBe(2);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(async () => Reflect.get(window, 'workflowUI').loseResponse());
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'workflowUI').status().error))
    .toContain('lost the accepted');
  expect((await state(page)).undoCount).toBe(2);
  const undo = await state(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await state(page)).undoCount).toBe(1);
  expect((await state(page)).workflow.history).toEqual(undo.workflow.history);
  expect((await state(page)).checkpoint).toBe(before.checkpoint);
  expect((await state(page)).original).toEqual([1, 0, 255, 42]);
});

test('a delayed real API hydration reply cannot replace a confirmed restore base', async ({
  page,
}) => {
  await page.evaluate(
    async (input) => Reflect.get(window, 'workflowUI').mount(input, 'self-hosted'),
    input,
  );
  await open(page);
  await save(page, 'Original');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(async () => Reflect.get(window, 'workflowUI').edit(1.25));
  const changed = await state(page);
  await page.evaluate(
    async (xml) => Reflect.get(window, 'workflowUI').replace(xml),
    changed.xml.replace('exact &amp; kept', 'delayed &amp; stale'),
  );
  await open(page);
  await page.getByRole('button', { name: 'Restore Snapshot: Original', exact: true }).click();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  await page.route('**/api/xmp?*', async (route) => {
    if (!first) {
      await route.continue();
      return;
    }
    first = false;
    // Delay the actual endpoint's original reply without substituting any XMP.
    const response = await route.fetch();
    entered.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    await page.evaluate(() => Reflect.get(window, 'workflowUI').startLateRead());
    await entered.promise;
    await page
      .getByRole('dialog', { name: 'Restore this version?' })
      .getByRole('button', { name: 'Restore', exact: true })
      .click();
    await expect(
      page.getByRole('dialog', { name: 'Snapshots and history', exact: true }),
    ).toBeVisible();
    release.resolve();
    const hydrated = await page.evaluate(async () =>
      Reflect.get(window, 'workflowUI').finishLateRead(),
    );
    expect(hydrated.passthrough.unknownNodes.join('')).toContain(opaque);
    expect(hydrated.passthrough.unknownNodes.join('')).not.toContain('delayed &amp; stale');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').edit(2));
    const saved = await state(page);
    expect(saved.checkpoint).toContain(opaque);
    expect(saved.checkpoint).not.toContain('delayed &amp; stale');
    expect(saved.original).toEqual([1, 0, 255, 42]);
  } finally {
    release.resolve();
  }
});
