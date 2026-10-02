// Local experiment #3941: production UI + actual ONNX + real directory/XMP.
// This is a workflow gate; the synthetic RAW cannot qualify photo quality.
import { test, expect } from '@playwright/test';
import { mkdtemp, copyFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { savedPng } from './saved-export-oracle';
import { installProductionFolderPicker } from '../support/production-folder-picker';

const fixture = resolve(__dirname, '../../../../test-fixtures/removal/basic/source.dng');
const modelRoot = process.env.MAPLE_REMOVAL_MODEL_DIR ?? '/tmp/maple-removal-models';
const lama = join(modelRoot, 'lama/native-build/lama-native-1024.onnx');

test('Paint, inspect, cancel, Keep and reopen use actual local RAW removal assets', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const root = await mkdtemp(join(tmpdir(), 'maple-removal-ui-'));
  const original = await readFile(fixture);
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  try {
    await copyFile(fixture, join(root, 'photo.dng'));
    await installProductionFolderPicker(page, root);
    await page.addInitScript(() => {
      const replies: { width?: number; height?: number; message?: string }[] = [];
      Object.defineProperty(window, '__mapleDetailReplies', { value: replies });
      const Original = window.Worker;
      window.Worker = new Proxy(Original, {
        construct(target, args) {
          const worker = Reflect.construct(target, args) as Worker;
          worker.addEventListener('message', ({ data }) => {
            if (data?.type === 'native-detail-success')
              replies.push({ width: data.width, height: data.height });
            else if (data?.type === 'native-detail-error') replies.push({ message: data.message });
          });
          return worker;
        },
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: /open a folder/i }).click();
    await page.getByRole('button', { name: 'photo.dng', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const gpuCanvas = page.locator('canvas[data-gpu-live]');
    if (testInfo.project.name === 'removal-webgpu') await expect(gpuCanvas).toBeVisible();
    else {
      await expect(gpuCanvas).toHaveCount(0);
      // The persistent fallback toast can cover the normal header Undo button.
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    }
    await page
      .getByRole('navigation', { name: 'Editor tools' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    const panel = page.getByTestId('removal-panel');
    const exportSaved = async (name: string) => {
      await page.getByTestId('editor-shell-export').click();
      const dialog = page.getByRole('dialog', { name: 'Export image', exact: true });
      await dialog.getByRole('radio', { name: 'PNG', exact: true }).click();
      const downloading = page.waitForEvent('download');
      await dialog.getByRole('button', { name: 'Export', exact: true }).click();
      const download = await downloading;
      expect(download.suggestedFilename()).toBe('photo.png');
      const destination = testInfo.outputPath(name + '.png');
      await download.saveAs(destination);
      expect(new Uint8Array(await readFile(destination))).toEqual(
        await savedPng(root, testInfo.outputPath(name + '-oracle.png')),
      );
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(dialog).toBeHidden();
    };
    await expect(panel.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
    await panel.getByText('Local AI models', { exact: true }).click();
    await expect(panel.getByLabel('Import local removal models')).toBeEnabled();
    await panel.getByLabel('Import local removal models').setInputFiles(lama);
    await expect(
      panel.getByText('lama-native-1024.onnx · Installed', { exact: false }),
    ).toBeVisible();
    await expect(panel.getByRole('slider', { name: 'Brush size' })).toBeEnabled();
    await panel.getByRole('slider', { name: 'Brush size' }).press('ArrowRight');
    const overlay = page.getByRole('img', { name: /Paint to select objects/ });
    const rect = await overlay.boundingBox();
    if (!rect) throw Error('Remove overlay has no painted bounds');
    // The 16×8 fixture paints at 1:1 rather than upscaling. Pick a pixel
    // centre inside that actual centered footprint, not the viewport edge.
    await page.mouse.click(rect.x + rect.width / 2 - 1.5, rect.y + rect.height / 2 - 0.5);
    const remove = panel.getByRole('button', { name: 'Remove', exact: true });
    await expect(remove).toBeEnabled();
    await remove.click();
    await expect(panel.getByRole('button', { name: 'Keep', exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await page.screenshot({ path: testInfo.outputPath('review.png') });
    const before = await readdir(root);
    expect(before).not.toContain('photo.xmp');
    await panel
      .getByRole('button', { name: 'Compare removal with the current photo', exact: true })
      .click();
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(remove).toBeEnabled();
    expect(await readdir(root)).not.toContain('photo.xmp');
    await remove.click();
    await expect(panel.getByRole('button', { name: 'Keep', exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await panel.getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(panel.getByText('Removal saved.', { exact: true })).toBeVisible();
    const accepted = await readFile(join(root, 'photo.xmp'), 'utf8');
    expect(accepted).toContain('InpaintRemovals');
    expect(await readdir(join(root, '.maple/inpaint'))).toHaveLength(2);
    expect(await readFile(join(root, 'photo.dng'))).toEqual(original);
    await page.screenshot({ path: testInfo.outputPath('kept.png') });
    // Saved-row edits use the normal confirmed history and retain their assets.
    const expandSaved = async () => {
      const summary = panel.getByText('Saved removals', { exact: true });
      const details = panel.locator('details').filter({ hasText: 'Saved removals' });
      if ((await details.getAttribute('open')) === null) await summary.click();
    };
    await expandSaved();
    const row = panel.locator('[data-removal-id]');
    const id = await row.getAttribute('data-removal-id');
    expect(id).toMatch(/^blake3:[a-f0-9]{64}$/);
    const undoToAccepted = async () => {
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect.poll(() => readFile(join(root, 'photo.xmp'), 'utf8')).toBe(accepted);
      await expect(panel.getByRole('slider', { name: 'Brush size' })).toBeEnabled();
    };
    await panel.getByRole('button', { name: 'Disable removal 1', exact: true }).click();
    await expect(row.getByText('Removal 1 · Disabled', { exact: true })).toBeVisible();
    const disabled = await readFile(join(root, 'photo.xmp'), 'utf8');
    expect(disabled).toContain('&quot;schema&quot;:5');
    expect(disabled).toContain('&quot;active&quot;:false');
    await exportSaved('disabled-removal');
    await expect(panel.getByRole('slider', { name: 'Brush size' })).toBeEnabled();
    await panel.getByRole('button', { name: 'Enable removal 1', exact: true }).click();
    await expect(row.getByText('Removal 1 · Enabled', { exact: true })).toBeVisible();
    expect(await row.getAttribute('data-removal-id')).toBe(id);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => readFile(join(root, 'photo.xmp'), 'utf8')).toBe(disabled);
    await undoToAccepted();
    await expandSaved();
    await panel.getByRole('button', { name: 'Delete removal 1', exact: true }).click();
    await expect(row).toHaveCount(0);
    expect(await readdir(join(root, '.maple/inpaint'))).toHaveLength(2);
    await undoToAccepted();
    await expandSaved();
    await panel.getByRole('button', { name: 'Replace removal 1', exact: true }).click();
    await expect(
      panel.getByRole('button', { name: 'Cancel replacement', exact: true }),
    ).toBeVisible();
    await expect(remove).toBeEnabled();
    await page.mouse.click(rect.x + rect.width / 2 + 4.5, rect.y + rect.height / 2 - 0.5);
    await panel.getByRole('button', { name: 'Undo selection stroke', exact: true }).click();
    await panel.getByRole('button', { name: 'Redo selection stroke', exact: true }).click();
    await remove.click();
    await expect(panel.getByRole('button', { name: 'Keep', exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await exportSaved('replacement-review-current-edit');
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await readFile(join(root, 'photo.xmp'), 'utf8')).toBe(accepted);
    await remove.click();
    await expect(panel.getByRole('button', { name: 'Keep', exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await panel.getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(panel.getByText('Removal saved.', { exact: true })).toBeVisible();
    expect(await row.getAttribute('data-removal-id')).toBe(id);
    expect(await readFile(join(root, 'photo.xmp'), 'utf8')).toContain('&quot;schema&quot;:5');
    await page.screenshot({ path: testInfo.outputPath('saved-replacement.png') });
    await panel
      .getByRole('button', { name: 'Remove model lama-native-1024.onnx', exact: true })
      .click();
    await expect(
      panel.getByText('lama-native-1024.onnx · Required', { exact: false }),
    ).toBeVisible();
    await exportSaved('schema5-replacement-without-model');
    await panel.getByLabel('Import local removal models').setInputFiles(lama);
    await expect(
      panel.getByText('lama-native-1024.onnx · Installed', { exact: false }),
    ).toBeVisible();
    await expect(panel.getByRole('slider', { name: 'Brush size' })).toBeEnabled();
    await undoToAccepted();
    // Replacement assets remain for redo; reopening only prepares referenced assets.
    expect((await readdir(join(root, '.maple/inpaint'))).length).toBeGreaterThanOrEqual(2);
    // Unmount tool and reopen the same persisted recipe in the normal canvas.
    await page
      .getByRole('navigation', { name: 'Editor tools' })
      .getByRole('button', { name: 'Light', exact: true })
      .click();
    // Normal editor history survives closing Remove. Undo/redo must confirm
    // the real XMP and restore the same baked assets without another model run.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(() => readFile(join(root, 'photo.xmp'), 'utf8'))
      .toContain('papp:InpaintRemovals="[]"');
    await page.screenshot({ path: testInfo.outputPath('global-removal-undone.png') });
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => readFile(join(root, 'photo.xmp'), 'utf8')).toBe(accepted);
    expect((await readdir(join(root, '.maple/inpaint'))).length).toBeGreaterThanOrEqual(2);
    const announcement = page.locator('.cdk-live-announcer-element');
    await expect(announcement).toHaveCSS('position', 'absolute');
    await expect(announcement).toHaveCSS('width', '1px');
    await page.screenshot({ path: testInfo.outputPath('global-removal-redone.png') });
    await page
      .getByRole('navigation', { name: 'Editor tools' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await expect(
      panel.getByRole('button', { name: 'Suggest background people', exact: true }),
    ).toHaveCount(0);
    await expect(panel.getByRole('slider', { name: 'Brush size' })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('reopened.png') });
    expect(await readFile(join(root, 'photo.xmp'), 'utf8')).toBe(accepted);
    if (testInfo.project.name === 'removal-cpu') {
      await page.keyboard.press('Control+1');
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, '__mapleDetailReplies')))
        .toContainEqual({ width: 16, height: 8 });
      await page.keyboard.press('Control+0');
    }
    await panel.getByText('Local AI models', { exact: true }).click();
    await panel
      .getByRole('button', { name: 'Remove model lama-native-1024.onnx', exact: true })
      .click();
    await expect(
      panel.getByText('lama-native-1024.onnx · Required', { exact: false }),
    ).toBeVisible();
    await exportSaved('photo');
    expect(await readFile(join(root, 'photo.dng'))).toEqual(original);
    await expect(panel.getByRole('slider', { name: 'Brush size' })).toBeEnabled();
    await page.mouse.click(rect.x + rect.width / 2 - 1.5, rect.y + rect.height / 2 - 0.5);
    await expect(panel.getByRole('button', { name: 'Clear selection', exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('exported.png') });
    expect(failures).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
