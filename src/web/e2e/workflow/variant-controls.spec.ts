import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const foreign =
  '<vendor:Audit xmlns:vendor="urn:maple:test:opaque"> exact &amp; kept </vendor:Audit>';
const input = readFileSync(
  resolve('../../test-fixtures/local-adjustments/lightroom-group-add.xmp'),
  'utf8',
).replace('<crs:MaskGroupBasedCorrections>', foreign + '\n<crs:MaskGroupBasedCorrections>');
const state = (page: Page) =>
  page.evaluate(async () => Reflect.get(window, 'workflowUI').variantState());
const open = async (page: Page) => {
  await page.getByRole('button', { name: 'Snapshots and history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New variant', exact: true })).toBeEnabled();
};
const edit = (page: Page, value: number) =>
  page.evaluate(async (value) => Reflect.get(window, 'workflowUI').edit(value), value);
for (const backend of ['hosted', 'self-hosted'] as const)
  test(`${backend}: actual variant controls isolate edits, complete snapshots, Undo and reopen`, async ({
    page,
  }, info) => {
    await page.goto('http://localhost:4520');
    await page.waitForFunction(() => Reflect.get(window, 'workflowUI'));
    await page.evaluate(
      async ({ input, backend }) => Reflect.get(window, 'workflowUI').mount(input, backend),
      { input, backend },
    );
    const original = await state(page);
    await open(page);
    await page.getByRole('button', { name: 'New variant', exact: true }).click();
    await page.getByRole('textbox').fill('Night');
    await page.getByRole('button', { name: 'Create variant', exact: true }).click();
    await expect.poll(async () => (await state(page)).record?.variantName).toBe('Night');
    const created = await state(page);
    expect(created.variantId).not.toBe('primary');
    expect(created.primary).toBe(input);
    expect(created.original).toEqual([1, 0, 255, 42]);
    await edit(page, 1.25);
    await open(page);
    await page.getByRole('button', { name: 'Save snapshot', exact: true }).click();
    await page.getByRole('textbox').fill('Night checkpoint');
    await page.getByRole('button', { name: 'Save snapshot', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Restore Snapshot: Night checkpoint', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await edit(page, 2.5);
    await open(page);
    await page
      .getByRole('button', { name: 'Restore Snapshot: Night checkpoint', exact: true })
      .click();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(async () => (await state(page)).model.exposure).toBe(1.25);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await state(page)).model.exposure).toBe(2.5);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(async () => (await state(page)).model.exposure).toBe(1.25);
    await open(page);
    await page.getByRole('button', { name: 'Use variant Primary', exact: true }).click();
    await expect.poll(async () => (await state(page)).variantId).toBe('primary');
    const primary = await state(page);
    expect(primary.model.exposure).toBe(original.model.exposure);
    expect(primary.undoCount).toBe(0);
    expect(primary.primary).toBe(input);
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page);
    const select = page.getByRole('button', { name: 'Use variant Night', exact: true });
    await expect(select).toBeVisible();
    await info.attach('Phone variant chooser', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await select.click();
    await expect.poll(async () => (await state(page)).model.exposure).toBe(1.25);
    const selected = await state(page);
    expect(selected.record.snapshots).toHaveLength(1);
    expect(selected.xml).toContain(foreign);
    expect(selected.primary).toBe(input);
    await page.evaluate(async () => Reflect.get(window, 'workflowUI').reopen());
    await open(page);
    await page.getByRole('button', { name: 'Use variant Night', exact: true }).click();
    await expect.poll(async () => (await state(page)).variantId).toBe(created.variantId);
    await edit(page, 3);
    const reopened = await state(page);
    expect(reopened.model.exposure).toBe(3);
    expect(reopened.record.snapshots).toEqual(selected.record.snapshots);
    expect(reopened.primary).toBe(input);
    expect(reopened.original).toEqual([1, 0, 255, 42]);
    expect(reopened.xml).toContain(foreign);
  });
