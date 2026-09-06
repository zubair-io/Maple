import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const fixtures = ['source', 'target'].map((name) => ({
  name: name + '.dng',
  bytes: [
    ...readFileSync(resolve(process.cwd(), '../../test-fixtures/batch-transfer/' + name + '.dng')),
  ],
}));
const xmp = (exposure: number, temperature: number, tint: number) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" crs:Exposure2012="${exposure}" crs:WhiteBalance="Custom" crs:Temperature="${temperature}" crs:Tint="${tint}" papp:WbSource="Manual" papp:WbScaleVersion="5"/></rdf:RDF></x:xmpmeta>`;

async function openLibrary(page: Page, additional: { name: string; bytes: number[] }[] = []) {
  await page.addInitScript(
    ({ fixtures, sourceXmp, targetXmp }) => {
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value: async () => {
          const root = await navigator.storage.getDirectory();
          const folder = await root.getDirectoryHandle('Batch fixtures', { create: true });
          for (const file of [
            ...fixtures,
            { name: 'source.xmp', bytes: [...new TextEncoder().encode(sourceXmp)] },
            { name: 'target.xmp', bytes: [...new TextEncoder().encode(targetXmp)] },
          ]) {
            const handle = await folder.getFileHandle(file.name, { create: true });
            const writer = await handle.createWritable();
            await writer.write(new Uint8Array(file.bytes));
            await writer.close();
          }
          return folder;
        },
      });
    },
    {
      fixtures: [...fixtures, ...additional],
      sourceXmp: xmp(1.25, 8550, 24),
      targetXmp: xmp(-0.5, 5050, 38),
    },
  );
  await page.goto('/browse');
  await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'source.dng', exact: true })).toBeVisible();
}

test('real Hosted dialog previews values and commits relative WB through the persistent worker', async ({
  page,
}, testInfo) => {
  await openLibrary(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'target.dng', exact: true }).click();
  await page.getByRole('button', { name: 'source.dng', exact: true }).click();
  await page.getByRole('button', { name: 'Copy settings', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('before-paste.png'), fullPage: true });
  await page.getByRole('button', { name: 'Paste settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Paste Settings/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Exposure');
  await expect(dialog).toContainText('Mixed: -0.5, 1.25');
  await expect(dialog).toContainText('1.25');
  await dialog
    .getByRole('checkbox', { name: 'White balance relative to each photo’s As Shot', exact: true })
    .check();
  await expect(dialog).toContainText('As Shot +1200 K, tint +10', { timeout: 60000 });
  await page.screenshot({ path: testInfo.outputPath('relative-preview.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Select none', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'White Balance', exact: true }).check();
  await dialog.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.getByTestId('batch-sync-summary')).toContainText('2 images updated');
  const saved = await page.evaluate(async () => {
    const folder = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('Batch fixtures');
    return (await (await folder.getFileHandle('target.xmp')).getFile()).text();
  });
  expect(saved).toContain('crs:Temperature="6250"');
  expect(saved).toContain('crs:Tint="48"');
  expect(saved).toContain('crs:Exposure2012="-0.5"');
});

test('two photos sharing one sidecar are rejected before any batch write', async ({ page }) => {
  await openLibrary(page, [{ name: 'source.nef', bytes: fixtures[0].bytes }]);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'source.nef', exact: true }).click();
  await page.getByRole('button', { name: 'source.dng', exact: true }).click();
  await page.getByRole('button', { name: 'Copy settings', exact: true }).click();
  await page.getByRole('button', { name: 'Paste settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Paste Settings/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('share the same XMP sidecar');
  const saved = await page.evaluate(async () => {
    const folder = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('Batch fixtures');
    return (await (await folder.getFileHandle('source.xmp')).getFile()).text();
  });
  expect(saved).toBe(xmp(1.25, 8550, 24));
});

test('a resumed sidecar writer waits for the main-thread write lock', async ({ page }) => {
  await openLibrary(page);
  await page.evaluate(() => {
    const state = window as unknown as { releaseBatchWrite?: () => void; batchWriteHeld?: boolean };
    void navigator.locks.request('maple-batch-sidecar-write', async () => {
      state.batchWriteHeld = true;
      await new Promise<void>((resolve) => {
        state.releaseBatchWrite = resolve;
      });
    });
  });
  await page.waitForFunction(
    () => (window as unknown as { batchWriteHeld: boolean }).batchWriteHeld,
  );
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'target.dng', exact: true }).click();
  await page.getByRole('button', { name: 'source.dng', exact: true }).click();
  await page.getByRole('button', { name: 'Copy settings', exact: true }).click();
  await page.getByRole('button', { name: 'Paste settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Paste Settings/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.getByTestId('batch-sync-progress')).toBeVisible();
  await page.waitForFunction(async () =>
    (await navigator.locks.query()).pending?.some(
      (lock) => lock.name === 'maple-batch-sidecar-write',
    ),
  );
  const before = await page.evaluate(async () => {
    const folder = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('Batch fixtures');
    return (await (await folder.getFileHandle('target.xmp')).getFile()).text();
  });
  expect(before).toBe(xmp(-0.5, 5050, 38));
  await page.evaluate(() =>
    (window as unknown as { releaseBatchWrite: () => void }).releaseBatchWrite(),
  );
  await expect(page.getByTestId('batch-sync-summary')).toContainText('2 images updated');
});
