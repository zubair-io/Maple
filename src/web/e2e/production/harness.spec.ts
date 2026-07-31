import { access, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test, expect } from '../support/production-test';
import { readProductionFixtureManifest } from '../support/production-fixtures';

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
  expect(manifest.stagedRawHashes).toHaveLength(5);
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

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download XMP' }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(download.suggestedFilename()).toBe('test_0006.xmp');
  expect(downloadPath).not.toBeNull();
  expect(await readFile(downloadPath!, 'utf8')).toContain('<x:xmpmeta');
});
