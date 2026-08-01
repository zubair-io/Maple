import type { Locator, Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '../support/production-test';
import {
  readProductionFixtureManifest,
  verifyStagedRawHashes,
} from '../support/production-fixtures';
import { installProductionFolderPicker } from '../support/production-folder-picker';
import { renderedPixelSample } from '../support/rendered-pixels';
import { openSelfHostedFixture } from '../support/self-hosted-production';

// This spec injects a real one-shot /api/image failure. Playwright cannot
// route requests owned by a service worker, whose install/update/offline
// contract has its own production suite. Keep the fault injection observable
// at the browser network boundary here.
test.use({ serviceWorkers: 'block' });

const RAF = 'test_0008.RAF';
const X3F = 'test_0016.X3F';
const EMPTY_XMP =
  '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

async function expectImageLoaded(image: Locator): Promise<void> {
  await expect(image).toBeVisible({ timeout: 90_000 });
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth), {
      timeout: 90_000,
    })
    .toBeGreaterThan(0);
}

async function expectNonblankPixels(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible({ timeout: 90_000 });
  await expect
    .poll(async () => (await renderedPixelSample(locator)).lumaRange, { timeout: 90_000 })
    .toBeGreaterThan(16);
  const stats = await renderedPixelSample(locator);
  expect(stats.opaquePixels, 'rendered surface must contain visible pixels').toBeGreaterThan(0);
  expect(
    stats.lumaRange,
    'rendered surface must contain photographic, nonblank pixels',
  ).toBeGreaterThan(16);
}

async function openPreview(page: Page, filename: string): Promise<Locator> {
  await page.getByRole('button', { name: filename, exact: true }).click();
  await expect(page).toHaveURL(/\/view\//);
  const preview = page.locator('.preview-img--full');
  await expectImageLoaded(preview);
  await expectNonblankPixels(preview);
  return preview;
}

async function openEditor(page: Page): Promise<Locator> {
  const dismissLanBanner = page.getByRole('button', { name: 'Dismiss', exact: true });
  if (await dismissLanBanner.isVisible()) await dismissLanBanner.click();
  await page.getByLabel('Edit', { exact: true }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.getByText('Decoding RAW...', { exact: true })).toHaveCount(0, {
    timeout: 90_000,
  });
  const canvas = page.locator('editor-image-canvas canvas:visible').last();
  await expectNonblankPixels(canvas);
  return canvas;
}

test('Hosted renders the X3F thumbnail, preview, and editor in installed Chrome', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  test.setTimeout(300_000);
  const manifest = await readProductionFixtureManifest();
  await installProductionFolderPicker(page, manifest.freshFolder);

  await page.goto('/');
  await page.getByRole('button', { name: /open a folder/i }).click();
  const tile = page.getByRole('button', { name: X3F, exact: true });
  await expect(tile).toBeVisible({ timeout: 90_000 });
  await expectImageLoaded(tile.locator('img'));
  await openPreview(page, X3F);
  await openEditor(page);
  await verifyStagedRawHashes(manifest);
});

test('Self Hosted reopens RAF pixels and recovers a named one-shot byte failure', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-self-hosted');
  test.setTimeout(360_000);
  const manifest = await readProductionFixtureManifest();
  await Promise.all(
    ['test_0004.xmp', 'test_0006.xmp', 'test_0008.xmp', 'test_0016.xmp'].map((filename) =>
      writeFile(join(manifest.freshFolder, filename), EMPTY_XMP),
    ),
  );
  await page.addInitScript(() => localStorage.setItem('cm.preview.infoOpen', 'false'));
  await openSelfHostedFixture(page, manifest.freshFolder, 'RAW reliability fixture');

  const x3fTile = page.getByRole('button', { name: X3F, exact: true });
  await expect(x3fTile).toBeVisible({ timeout: 90_000 });
  await expectImageLoaded(x3fTile.locator('img'));
  await openPreview(page, X3F);
  await openEditor(page);

  await page.goto('/browse');
  const rafTile = page.getByRole('button', { name: RAF, exact: true });
  await expect(rafTile).toBeVisible({ timeout: 90_000 });
  await openPreview(page, RAF);
  let failedOnce = false;
  await page.route('**/api/image/**', async (route) => {
    if (!failedOnce && decodeURIComponent(route.request().url()).endsWith(RAF)) {
      failedOnce = true;
      await route.fulfill({
        status: 403,
        contentType: 'text/plain',
        body: 'injected read failure',
      });
      return;
    }
    await route.continue();
  });
  testInfo.annotations.push({
    type: 'expected-console-error',
    description: 'Failed to load resource: the server responded with a status of 403',
  });
  testInfo.annotations.push({
    type: 'expected-console-error',
    description: '[image-canvas] bytesForAsset failed:',
  });
  testInfo.annotations.push({
    type: 'expected-response-error',
    description: `403 GET ${new URL(testInfo.project.use.baseURL!).origin}/api/image/`,
  });

  const dismissLanBanner = page.getByRole('button', { name: 'Dismiss', exact: true });
  if (await dismissLanBanner.isVisible()) await dismissLanBanner.click();
  await page.getByLabel('Edit', { exact: true }).click();
  await expect(page).toHaveURL(/\/edit\//);
  const error = page.getByTestId('byte-load-error');
  await expect(error).toContainText(RAF, { timeout: 90_000 });
  await expect(error).toContainText('HTTP 403');
  await expect(page.getByRole('button', { name: `Retry loading ${RAF}` })).toBeVisible();
  expect(failedOnce, 'the browser must exercise the injected byte-read failure').toBe(true);

  await page.getByRole('button', { name: `Retry loading ${RAF}` }).click();
  await expect(error).toHaveCount(0, { timeout: 90_000 });
  await expectNonblankPixels(page.locator('editor-image-canvas canvas:visible').last());

  const editorUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(editorUrl);
  await expect(page.getByText(RAF, { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  await expectNonblankPixels(page.locator('editor-image-canvas canvas:visible').last());
  await verifyStagedRawHashes(manifest);
});
