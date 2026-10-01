// Local experiment #3941: production UI + actual ONNX + real directory/XMP.
// This is a workflow gate; the synthetic RAW cannot qualify photo quality.
import { test, expect } from '@playwright/test';
import { mkdtemp, copyFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
    await page.goto('/');
    await page.getByRole('button', { name: /open a folder/i }).click();
    await page.getByRole('button', { name: 'photo.dng', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const gpuCanvas = page.locator('canvas[data-gpu-live]');
    if (testInfo.project.name === 'removal-webgpu') await expect(gpuCanvas).toBeVisible();
    else await expect(gpuCanvas).toHaveCount(0);
    await page
      .getByRole('navigation', { name: 'Editor tools' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    const panel = page.getByTestId('removal-panel');
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
    // Unmount tool and reopen the same persisted recipe in the normal canvas.
    await page
      .getByRole('navigation', { name: 'Editor tools' })
      .getByRole('button', { name: 'Light', exact: true })
      .click();
    await page
      .getByRole('navigation', { name: 'Editor tools' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await expect(panel.getByRole('button', { name: 'Find people', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('slider', { name: 'Brush size' })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('reopened.png') });
    expect(await readFile(join(root, 'photo.xmp'), 'utf8')).toBe(accepted);
    expect(failures).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
