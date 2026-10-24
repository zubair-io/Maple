import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Locator, Request } from '@playwright/test';
import { expect, test } from '../support/production-test';
import { readProductionFixtureManifest } from '../support/production-fixtures';
import { installProductionFolderPicker } from '../support/production-folder-picker';
import { openHostedFolderEditor } from '../support/production-editor';
import { openSelfHostedFixture } from '../support/self-hosted-production';
import { RESOLVED_PREVIEW_SELECTOR } from '../support/preview-surface';
import {
  renderedPixelDistance,
  renderedPixelSample,
  type RenderedPixelSample,
} from '../support/rendered-pixels';

const FILENAME = 'test_0006.DNG';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function xmpExposure(path: string): Promise<number | null> {
  const xml = await readFile(path, 'utf8').catch(() => '');
  if (!xml.includes('<rdf:RDF')) return null;
  const match = xml.match(/crs:Exposure2012="([^"]+)"/);
  if (!match) return 0; // Canonical XMP omits the default exposure.
  const exposure = Number(match[1]);
  return Number.isFinite(exposure) ? exposure : null;
}

async function stableCanvasSample(canvas: Locator): Promise<RenderedPixelSample> {
  let previous: RenderedPixelSample | null = null;
  await expect
    .poll(
      async () => {
        const current = await renderedPixelSample(canvas);
        const stable = previous !== null && renderedPixelDistance(previous, current) < 0.05;
        previous = current;
        return stable;
      },
      { intervals: [250], timeout: 30_000 },
    )
    .toBe(true);
  return previous!;
}

test('Hosted editor commits Undo/Redo and Auto as visible, bounded, persistent actions', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  const manifest = await readProductionFixtureManifest();
  const folder = join(manifest.root, 'editor-interactions');
  const rawPath = join(folder, FILENAME);
  const sidecarPath = join(folder, 'test_0006.xmp');
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  await copyFile(join(manifest.freshFolder, FILENAME), rawPath);
  const originalHash = sha256(await readFile(rawPath));

  await installProductionFolderPicker(page, folder);
  await openHostedFolderEditor(page, FILENAME);

  const exposure = page.getByRole('slider', { name: 'Exposure' });
  const undo = page.getByTestId('editor-shell-undo');
  const canvas = page.locator('editor-image-canvas canvas[data-gpu-live]');
  await expect(canvas).toBeVisible();
  const initialExposure = Number(await exposure.getAttribute('aria-valuenow'));
  const initialPixels = await stableCanvasSample(canvas);

  await exposure.focus();
  await exposure.press('ArrowRight');
  await expect(exposure).not.toHaveAttribute('aria-valuenow', String(initialExposure));
  const editedExposure = Number(await exposure.getAttribute('aria-valuenow'));
  expect(editedExposure).toBeGreaterThan(initialExposure);
  await expect(undo).toBeEnabled();
  await expect.poll(() => xmpExposure(sidecarPath)).toBe(editedExposure);
  const editedPixels = await stableCanvasSample(canvas);
  const editDistance = renderedPixelDistance(initialPixels, editedPixels);
  expect(editDistance).toBeGreaterThan(0.1);

  await undo.click();
  await expect(exposure).toHaveAttribute('aria-valuenow', String(initialExposure));
  await expect.poll(() => xmpExposure(sidecarPath)).toBe(initialExposure);
  const undonePixels = await stableCanvasSample(canvas);
  expect(renderedPixelDistance(undonePixels, initialPixels)).toBeLessThan(editDistance);

  const undoBox = await undo.boundingBox();
  expect(undoBox).not.toBeNull();
  await undo.hover();
  await page.mouse.move(undoBox!.x + undoBox!.width / 2, undoBox!.y + undoBox!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.mouse.up();
  await expect(exposure).toHaveAttribute('aria-valuenow', String(editedExposure));
  await expect.poll(() => xmpExposure(sidecarPath)).toBe(editedExposure);
  const redonePixels = await stableCanvasSample(canvas);
  expect(renderedPixelDistance(redonePixels, editedPixels)).toBeLessThan(
    renderedPixelDistance(undonePixels, editedPixels),
  );

  const auto = page.getByRole('button', { name: 'Auto adjust' });
  await auto.click();
  await expect(auto).toHaveAttribute('aria-busy', 'true');
  const autoResult = page.getByRole('status').filter({ hasText: /Auto/ });
  await expect(autoResult).toHaveText(/^\s*Auto applied · Exposure [+-]\d+\.\d{2} EV\s*$/, {
    timeout: 60_000,
  });
  await expect(auto).not.toHaveAttribute('aria-busy', 'true');
  const autoExposure = Number(await exposure.getAttribute('aria-valuenow'));
  await expect
    .poll(async () => {
      const persisted = await xmpExposure(sidecarPath);
      return persisted === null ? Number.POSITIVE_INFINITY : Math.abs(persisted - autoExposure);
    })
    .toBeLessThan(0.005);
  await expect.poll(() => readFile(sidecarPath, 'utf8')).toContain('papp:WbSource="Auto"');
  await expect(undo).toBeEnabled();

  // HSL/B&W/Grade aside, group switching itself is owned by the tool dock's
  // plain buttons (aria-current="page"), not a WAI-ARIA tablist — the former
  // role="tab" markup was retired for being accessibility-incomplete (see
  // control-card.component.html).
  const dock = page.getByRole('navigation', { name: 'Editor tools' });
  await dock.getByRole('button', { name: 'Color', exact: true }).click();
  await expect(undo).toBeEnabled();
  const tint = page.getByRole('slider', { name: 'Tint' });
  const [minimum, maximum, value] = await Promise.all(
    ['aria-valuemin', 'aria-valuemax', 'aria-valuenow'].map(async (attribute) =>
      Number(await tint.getAttribute(attribute)),
    ),
  );
  expect(minimum).toBe(-150);
  expect(maximum).toBe(150);
  expect(value).toBeGreaterThanOrEqual(minimum);
  expect(value).toBeLessThanOrEqual(maximum);

  await dock.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(exposure).toHaveAttribute('aria-valuenow', String(editedExposure));
  await expect.poll(() => xmpExposure(sidecarPath)).toBe(editedExposure);
  expect(sha256(await readFile(rawPath))).toBe(originalHash);

  await testInfo.attach('editor-interaction-values.json', {
    body: Buffer.from(
      JSON.stringify({ initialExposure, editedExposure, autoExposure, tint: value }, null, 2),
    ),
    contentType: 'application/json',
  });
});

test('Self Hosted persists Auto after Undo/Redo and restores the preceding edit', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-self-hosted');
  const manifest = await readProductionFixtureManifest();
  const folder = await mkdtemp(join(manifest.root, 'self-hosted-auto-'));
  const rawPath = join(folder, FILENAME);
  const sidecarPath = join(folder, 'test_0006.xmp');
  await copyFile(join(manifest.freshFolder, FILENAME), rawPath);
  await writeFile(
    sidecarPath,
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
          crs:Exposure2012="0.25" crs:WhiteBalance="As Shot" />
      </rdf:RDF>
    </x:xmpmeta>`,
  );
  const originalHash = sha256(await readFile(rawPath));
  const pendingWrites = new Set<Request>();
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/xmp?')) {
      pendingWrites.add(request);
    }
  });
  const settleWrite = (request: Request): void => {
    pendingWrites.delete(request);
  };
  page.on('requestfinished', settleWrite);
  page.on('requestfailed', settleWrite);
  await openSelfHostedFixture(page, folder, `Auto interaction ${basename(folder)}`);
  const previewHistogram = page.waitForResponse(
    (response) => response.url().includes('/histogram') && response.ok(),
  );
  await page.getByRole('button', { name: FILENAME, exact: true }).click();
  await previewHistogram;
  const preview = page.locator(RESOLVED_PREVIEW_SELECTOR);
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const exposure = page.getByRole('slider', { name: 'Exposure' });
  await expect(exposure).toBeVisible({ timeout: 60_000 });
  await expect(exposure).toHaveAttribute('aria-valuenow', '0.25');
  const initialExposure = Number(await exposure.getAttribute('aria-valuenow'));
  await exposure.focus();
  await exposure.press('ArrowRight');
  await expect(exposure).not.toHaveAttribute('aria-valuenow', String(initialExposure));
  const editedExposure = Number(await exposure.getAttribute('aria-valuenow'));
  expect(editedExposure).toBeGreaterThan(initialExposure);
  await expect.poll(() => xmpExposure(sidecarPath)).toBe(editedExposure);
  const undo = page.getByTestId('editor-shell-undo');
  await undo.click();
  await expect(exposure).toHaveAttribute('aria-valuenow', String(initialExposure));
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(exposure).toHaveAttribute('aria-valuenow', String(editedExposure));

  const auto = page.getByRole('button', { name: 'Auto adjust' });
  await auto.click();
  await expect(auto).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status').filter({ hasText: /Auto/ })).toHaveText(
    /^\s*Auto applied · Exposure [+-]\d+\.\d{2} EV\s*$/,
    { timeout: 60_000 },
  );
  await expect(auto).not.toHaveAttribute('aria-busy', 'true');
  const autoExposure = Number(await exposure.getAttribute('aria-valuenow'));
  await expect
    .poll(async () => {
      const xml = await readFile(sidecarPath, 'utf8').catch(() => '');
      const persisted = await xmpExposure(sidecarPath);
      return (
        xml.includes('papp:WbSource="Auto"') &&
        persisted !== null &&
        Math.abs(persisted - autoExposure) < 0.005
      );
    })
    .toBe(true);
  await undo.click();
  await expect(exposure).toHaveAttribute('aria-valuenow', String(editedExposure));
  await expect.poll(() => xmpExposure(sidecarPath)).toBe(editedExposure);
  await expect.poll(() => pendingWrites.size).toBe(0);
  const undonePixels = await stableCanvasSample(
    page.locator('editor-image-canvas canvas[data-gpu-live]'),
  );
  expect(undonePixels.lumaRange).toBeGreaterThan(16);
  await expect.poll(() => pendingWrites.size).toBe(0);
  // Immediate hard reload after Auto/Undo remains a separate qualification
  // failure (#5225); keep this case focused on committed Auto and Undo.
  expect(sha256(await readFile(rawPath))).toBe(originalHash);
  await testInfo.attach('self-hosted-auto-values.json', {
    body: Buffer.from(
      JSON.stringify({ initialExposure, editedExposure, autoExposure, originalHash }),
    ),
    contentType: 'application/json',
  });
});
