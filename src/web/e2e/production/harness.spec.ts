import { access, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test, expect } from '../support/production-test';
import { readProductionFixtureManifest } from '../support/production-fixtures';
import { installProductionFolderPicker } from '../support/production-folder-picker';

function cacheFormatMatches(path: string, bytes: Buffer): boolean {
  if (path.endsWith('.jpg')) return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!path.endsWith('.avif') || bytes.length < 12) return false;
  const box = bytes.subarray(4, 8).toString('ascii');
  const brands = bytes.subarray(8).toString('ascii');
  return box === 'ftyp' && (brands.includes('avif') || brands.includes('avis'));
}

test('serves a production build in installed Google Chrome', async ({ page }, testInfo) => {
  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);
  expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => navigator.userAgent)).toContain('Chrome/');

  if (testInfo.project.name === 'chrome-hosted') {
    await expect(page.getByRole('button', { name: /open a photo/i })).toBeVisible();
  } else {
    const health = await page.request.get('/api/health');
    expect(health.ok()).toBe(true);
    expect(await health.json()).toMatchObject({ ok: true, product: 'maple' });
  }
});

test('uses disposable RAW copies and records immutable source hashes', async () => {
  const manifest = await readProductionFixtureManifest();
  expect(manifest.root).not.toContain('test-fixtures/raws');
  expect(manifest.sourceHashes).toHaveLength(5);
  expect(manifest.stagedRawHashes).toHaveLength(7);
  const sourceHashes = new Map(
    manifest.sourceHashes.map(({ path, sha256 }) => [basename(path).toLowerCase(), sha256]),
  );
  for (const staged of manifest.stagedRawHashes) {
    expect(staged.sha256).toBe(sourceHashes.get(basename(staged.path).toLowerCase()));
  }
  await Promise.all([
    access(`${manifest.populatedFolder}/.maple/thumbs`),
    access(`${manifest.populatedFolder}/.maple/previews`),
  ]);
  expect(await readFile(`${manifest.populatedFolder}/test_0017.xmp`, 'utf8')).toContain(
    '<x:xmpmeta',
  );
});

async function openWritableFolder(
  page: import('@playwright/test').Page,
  filename = 'test_0006.DNG',
): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /open a folder/i }).click();
  await expect(page).toHaveURL(/\/browse$/);
  await expect(page.getByRole('button', { name: filename, exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

async function openWritableRawEditor(page: import('@playwright/test').Page): Promise<void> {
  await openWritableFolder(page);
  await page.getByRole('button', { name: 'test_0006.DNG', exact: true }).click();
  await expect(page).toHaveURL(/\/view\//);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible({ timeout: 60_000 });
}

test('Hosted writable folder creates its .maple cache without modifying the RAW', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  const manifest = await readProductionFixtureManifest();
  await installProductionFolderPicker(page, manifest.writableFolder);

  const coldStarted = Date.now();
  await openWritableFolder(page);
  await expect(page.getByRole('status', { name: /save/i })).toHaveCount(0);

  await expect
    .poll(
      async () =>
        readdir(join(manifest.writableFolder, '.maple', 'thumbs')).catch(() => [] as string[]),
      { timeout: 90_000 },
    )
    .toEqual(expect.arrayContaining([expect.stringMatching(/\.(?:avif|jpg)$/)]));
  const thumbNames = await readdir(join(manifest.writableFolder, '.maple', 'thumbs'));
  for (const name of thumbNames.filter((candidate) => /\.(?:avif|jpg)$/.test(candidate))) {
    const path = join(manifest.writableFolder, '.maple', 'thumbs', name);
    expect(cacheFormatMatches(path, await readFile(path)), `${name} must match its extension`).toBe(
      true,
    );
  }
  await expect
    .poll(async () =>
      readFile(join(manifest.writableFolder, '.maple', 'index.json'), 'utf8').catch(() => ''),
    )
    .toContain('test_0006.DNG');
  const coldReadyMs = Date.now() - coldStarted;

  await page.goto('/');
  const warmStarted = Date.now();
  await openWritableFolder(page);
  const warmThumb = page.getByRole('button', { name: 'test_0006.DNG', exact: true }).locator('img');
  await expect(warmThumb).toBeVisible();
  await expect
    .poll(() => warmThumb.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  const warmReadyMs = Date.now() - warmStarted;
  expect(
    warmReadyMs,
    'warm folder paint must beat the measured cold cache generation',
  ).toBeLessThan(coldReadyMs);
  expect(
    warmReadyMs,
    'warm folder paint must stay inside the 5 second release ceiling',
  ).toBeLessThan(5_000);
  await testInfo.attach('hosted-folder-cold-warm-timing.json', {
    body: Buffer.from(JSON.stringify({ coldReadyMs, warmReadyMs }, null, 2)),
    contentType: 'application/json',
  });
});

test('Hosted uses an existing .maple preview before reading the RAW', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  const manifest = await readProductionFixtureManifest();
  const picker = await installProductionFolderPicker(page, manifest.populatedFolder);

  const openStarted = Date.now();
  await openWritableFolder(page, 'test_0017.dng');
  const browseReadyMs = Date.now() - openStarted;
  picker.clear();

  const previewStarted = Date.now();
  await page.getByRole('button', { name: 'test_0017.dng', exact: true }).click();
  const fullPreview = page.locator('.preview-img--full');
  await expect(fullPreview).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => fullPreview.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  const previewReadyMs = Date.now() - previewStarted;

  const previewRead = picker.operations.findIndex(
    ({ kind, path }) => kind === 'read' && path === '.maple/previews/test_0017.dng.avif',
  );
  const rawRead = picker.operations.findIndex(
    ({ kind, path }) => kind === 'read' && path === 'test_0017.dng',
  );
  expect(previewRead, 'the canonical cached preview must be read').toBeGreaterThanOrEqual(0);
  expect(rawRead, 'the cached preview must win before a RAW byte read').toBe(-1);
  expect(
    cacheFormatMatches(
      join(manifest.populatedFolder, '.maple', 'previews', 'test_0017.dng.avif'),
      await readFile(join(manifest.populatedFolder, '.maple', 'previews', 'test_0017.dng.avif')),
    ),
  ).toBe(true);

  await testInfo.attach('hosted-folder-cache-timing.json', {
    body: Buffer.from(JSON.stringify({ browseReadyMs, previewReadyMs }, null, 2)),
    contentType: 'application/json',
  });
});

test('Hosted writable folder writes XMP and restores it after a reload and re-open', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  const manifest = await readProductionFixtureManifest();
  await installProductionFolderPicker(page, manifest.writableFolder);

  await openWritableRawEditor(page);
  await expect(page.locator('editor-filmstrip')).toBeVisible();
  const exposure = page.getByRole('slider', { name: 'Exposure' });
  const selectedUrl = page.url();
  await exposure.focus();
  await exposure.press('ArrowRight');
  await expect(exposure).not.toHaveAttribute('aria-valuenow', '0');
  expect(page.url()).toBe(selectedUrl);
  await expect(page.getByRole('button', { name: 'test_0006.DNG', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  const editedExposure = await exposure.getAttribute('aria-valuenow');
  expect(editedExposure).not.toBeNull();
  expect(editedExposure).not.toBe('0');

  const sidecar = join(manifest.writableFolder, 'test_0006.xmp');
  await expect
    .poll(async () => readFile(sidecar, 'utf8').catch(() => ''))
    .toContain(`crs:Exposure2012="${editedExposure}"`);

  await page.reload();
  await expect(page).toHaveURL(/\/$/);
  await openWritableRawEditor(page);
  await expect(page.getByRole('slider', { name: 'Exposure' })).toHaveAttribute(
    'aria-valuenow',
    editedExposure!,
  );
});

test('Hosted opens one RAW directly and downloads its XMP without a filmstrip', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  const manifest = await readProductionFixtureManifest();

  await page.goto('/');
  await page
    .locator('input[type="file"]')
    .setInputFiles(join(manifest.freshFolder, 'test_0006.DNG'));

  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('editor-filmstrip')).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Single-file save' })).toContainText(
    'Download the XMP to keep your edits',
  );

  const exposure = page.getByRole('slider', { name: 'Exposure' });
  await expect(exposure).toBeVisible({ timeout: 60_000 });
  await exposure.focus();
  await exposure.press('ArrowRight');
  await expect(exposure).not.toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByTestId('editor-shell-undo')).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download XMP' }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(download.suggestedFilename()).toBe('test_0006.xmp');
  expect(downloadPath).not.toBeNull();
  const xml = await readFile(downloadPath!, 'utf8');
  expect(xml).toContain('<x:xmpmeta');
  expect(xml).toMatch(/crs:Exposure2012="(?!0(?:\.0+)?")/);
});
