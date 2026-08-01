import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../support/production-test';
import {
  EDITOR_ACTION_FILENAME,
  openDisposableHostedEditor,
  sha256File,
} from '../support/production-editor-actions';

test('Hosted editor chrome, metadata, export, and Back are complete actions', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  test.setTimeout(240_000);
  const { folder, rawPath, originalHash } = await openDisposableHostedEditor(
    page,
    'editor-action-chrome',
  );
  await expect(page.locator('editor-image-canvas canvas[data-gpu-live]')).toBeVisible();

  const reset = page.getByTestId('editor-shell-reset');
  const beforeAfter = page.getByTestId('editor-shell-before-after');
  const info = page.getByTestId('editor-shell-info');
  const exportButton = page.getByTestId('editor-shell-export');
  await expect(reset).toBeEnabled();
  await expect(page.getByTestId('editor-shell-auto')).toBeEnabled();
  await expect(page.getByTestId('editor-shell-undo')).toBeDisabled();

  const exposure = page.getByRole('slider', { name: 'Exposure' });
  await exposure.focus();
  await exposure.press('ArrowRight');
  await expect(exposure).not.toHaveAttribute('aria-valuenow', '0');
  await reset.click();
  await expect(exposure).toHaveAttribute('aria-valuenow', '0');
  await expect
    .poll(async () => {
      const xmp = await readFile(join(folder, 'test_0006.xmp'), 'utf8').catch(() => '');
      if (!xmp.includes('<rdf:RDF')) return null;
      const explicit = xmp.match(/crs:Exposure2012="([^"]+)"/);
      return explicit ? Number(explicit[1]) : 0;
    })
    .toBe(0);

  await expect(beforeAfter).toHaveAttribute('aria-pressed', 'false');
  await beforeAfter.click();
  await expect(beforeAfter).toHaveAttribute('aria-pressed', 'true');
  const divider = page.locator('.canvas-wrap > .cursor-ew-resize');
  await expect(divider).toBeVisible();
  const canvas = page.locator('.canvas-wrap');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await divider.hover();
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.7, bounds!.y + bounds!.height / 2);
  await page.mouse.up();
  await expect(divider).toHaveAttribute('style', /left:\s*7\d(?:\.\d+)?%/);
  await beforeAfter.click();
  await expect(beforeAfter).toHaveAttribute('aria-pressed', 'false');
  await expect(divider).toHaveCount(0);

  await expect(info).toHaveAttribute('aria-pressed', 'false');
  await info.click();
  await expect(info).toHaveAttribute('aria-pressed', 'true');
  const infoPanel = page.getByTestId('info-panel');
  await expect(infoPanel).toBeVisible();
  await page.getByRole('button', { name: 'Pick', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pick', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('radio', { name: '3 stars' }).click();
  await expect(page.getByRole('radio', { name: '3 stars' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('button', { name: 'Add keyword' }).click();
  await page.getByRole('textbox', { name: 'New keyword' }).fill('audit');
  await page.getByRole('textbox', { name: 'New keyword' }).press('Enter');
  await expect(page.getByRole('button', { name: /Keyword: audit/ })).toBeVisible();
  await info.click();
  await expect(infoPanel).toHaveCount(0);

  await exportButton.click();
  const dialog = page.getByRole('dialog', { name: 'Export image' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.getByLabel('Format').selectOption('jpeg');
  await page.getByLabel('Quality').fill('91');
  await page.getByLabel('Colour space').selectOption('srgb');
  await page.getByLabel('Size').selectOption('1024');
  await expect(dialog).toContainText(/Output: \d+ × \d+ px/);
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^test_0006\.(?:jpg|jpeg)$/i);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect((await stat(downloadPath!)).size).toBeGreaterThan(1_000);
  await expect(dialog).toContainText(/Exported test_0006\.(?:jpg|jpeg)/i);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(exportButton).toBeFocused();

  await exportButton.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/edit\//);
  await expect(exportButton).toBeFocused();

  await page.getByRole('button', { name: 'Back to Library' }).click();
  await expect(page).toHaveURL(/\/view\//);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  expect(await sha256File(rawPath)).toBe(originalHash);
  await testInfo.attach('editor-action-chrome.json', {
    body: Buffer.from(
      JSON.stringify({ filename: EDITOR_ACTION_FILENAME, download: download.suggestedFilename() }),
    ),
    contentType: 'application/json',
  });
});
