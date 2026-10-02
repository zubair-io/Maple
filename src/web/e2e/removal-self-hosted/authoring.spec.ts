// #3984: real local ONNX, real authenticated HTTP/SQLite, real XMP and assets.
import { test, expect } from '@playwright/test';
import { mkdtemp, copyFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openSelfHostedFixture } from '../support/self-hosted-production';
import { savedPng } from '../removal-experimental/saved-export-oracle';

const fixture = resolve(__dirname, '../../../../test-fixtures/removal/basic/source.dng');
const model = join(
  process.env.MAPLE_REMOVAL_MODEL_DIR ?? '/tmp/maple-removal-models',
  'lama/native-build/lama-native-1024.onnx',
);

test('Paint Keep, history, metadata, export and cold reopen use server companions without a folder handle', async ({
  page,
}, info) => {
  const runtime = JSON.parse(
    await readFile(
      resolve(__dirname, '../../test-results/removal-self-hosted-runtime.json'),
      'utf8',
    ),
  ) as { root: string };
  const root = await mkdtemp(join(runtime.root, 'paint-'));
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  try {
    await copyFile(fixture, join(root, 'photo.dng'));
    await copyFile(fixture.replace('source.dng', 'prior.xmp'), join(root, 'photo.xmp'));
    await openSelfHostedFixture(page, root, `Server removal ${info.project.name}`);
    await page.getByRole('button', { name: 'photo.dng', exact: true }).click();
    const lan = page.getByRole('button', { name: 'Dismiss', exact: true });
    if (await lan.isVisible()) await lan.click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const gpu = page.locator('canvas[data-gpu-live]');
    if (info.project.name === 'server-removal-webgpu') await expect(gpu).toBeVisible();
    else {
      await expect(gpu).toHaveCount(0);
      const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
      if (await dismiss.isVisible()) await dismiss.click();
    }
    await page
      .getByRole('navigation', { name: 'Editor tools' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    const panel = page.getByTestId('removal-panel');
    await panel.getByText('Local AI models', { exact: true }).click();
    await expect(panel.getByLabel('Import local removal models')).toBeEnabled();
    await panel.getByLabel('Import local removal models').setInputFiles(model);
    await expect(
      panel.getByText('lama-native-1024.onnx · Installed', { exact: false }),
    ).toBeVisible();
    await expect(panel.getByRole('slider', { name: 'Brush size' })).toBeEnabled();
    await panel.getByRole('slider', { name: 'Brush size' }).press('ArrowRight');
    const overlay = page.getByRole('img', { name: /Paint to select objects/ });
    await expect(overlay).toHaveAttribute('aria-disabled', 'false');
    const bounds = await overlay.boundingBox();
    if (!bounds) throw new Error('No painted RAW footprint');
    await page.mouse.click(bounds.x + bounds.width / 2 - 1.5, bounds.y + bounds.height / 2 - 0.5);
    await expect(panel.getByRole('button', { name: 'Undo selection stroke' })).toBeEnabled();
    await panel.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Keep', exact: true })).toBeVisible({
      timeout: 120_000,
    });
    // Review is ephemeral: no companion folder has been published yet.
    await expect(readdir(join(root, '.maple/inpaint'))).rejects.toThrow();
    await page.context().setOffline(true);
    await panel.getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(
      panel
        .getByRole('status')
        .filter({ hasText: 'Cannot reach the Maple server. Check your connection and retry.' }),
    ).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Keep', exact: true })).toBeEnabled();
    expect(await readFile(join(root, 'photo.xmp'), 'utf8')).toBe(
      await readFile(fixture.replace('source.dng', 'prior.xmp'), 'utf8'),
    );
    await expect(readdir(join(root, '.maple/inpaint'))).rejects.toThrow();
    await page.context().setOffline(false);
    const committed = page.waitForResponse(
      (response) =>
        response.url().includes('/api/removal/xmp') && response.request().method() === 'POST',
    );
    await panel.getByRole('button', { name: 'Keep', exact: true }).click();
    const result = await committed;
    expect(result.ok(), await result.text()).toBe(true);
    await expect(panel.getByText('Removal saved.', { exact: true })).toBeVisible();
    const xml = await readFile(join(root, 'photo.xmp'), 'utf8');
    expect(xml).toContain('InpaintRemovals');
    expect(xml).toContain('foreign:Keep="untouched"');
    expect(
      (await readdir(join(root, '.maple/inpaint'))).sort().map((name) => name.split('.').at(-1)),
    ).toEqual(['f16', 'mask'].sort());
    await page
      .getByRole('navigation', { name: 'Editor tools' })
      .getByRole('button', { name: 'Light', exact: true })
      .click();
    const fallback = page.getByRole('button', { name: 'Dismiss', exact: true });
    if (await fallback.isVisible()) await fallback.click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(() => readFile(join(root, 'photo.xmp'), 'utf8'))
      .toContain('papp:InpaintRemovals="[]"');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => readFile(join(root, 'photo.xmp'), 'utf8')).toBe(xml);
    const exposure = page.getByRole('slider', { name: 'Exposure', exact: true });
    const savingMetadata = page.waitForResponse(
      (response) =>
        response.url().includes('/api/removal/xmp') && response.request().method() === 'POST',
    );
    await exposure.press('ArrowRight');
    expect((await savingMetadata).ok()).toBe(true);
    await page.getByTestId('editor-shell-export').click();
    const dialog = page.getByRole('dialog', { name: 'Export image', exact: true });
    await dialog.getByRole('radio', { name: 'PNG', exact: true }).click();
    const downloading = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await downloading;
    const destination = info.outputPath('server-saved.png');
    await download.saveAs(destination);
    expect(new Uint8Array(await readFile(destination))).toEqual(
      await savedPng(root, info.outputPath('oracle.png')),
    );
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Editor tools' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await expect(page.getByTestId('removal-panel').locator('[data-removal-id]')).toHaveCount(1);
    await panel.getByText('Saved removals', { exact: true }).click();
    const changeSaved = async (name: string) => {
      const saving = page.waitForResponse(
        (response) =>
          response.url().includes('/api/removal/xmp') && response.request().method() === 'POST',
      );
      await panel.getByRole('button', { name, exact: true }).click();
      expect((await saving).ok()).toBe(true);
      await expect(panel.getByText('Removal saved.', { exact: true })).toBeVisible();
    };
    await changeSaved('Disable removal 1');
    await expect(panel.getByText('Removal 1 · Disabled', { exact: true })).toBeVisible();
    await changeSaved('Enable removal 1');
    await expect(panel.getByText('Removal 1 · Enabled', { exact: true })).toBeVisible();
    await changeSaved('Delete removal 1');
    await expect(panel.locator('[data-removal-id]')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Undo last removal', exact: true }).click();
    await expect(panel.locator('[data-removal-id]')).toHaveCount(1);
    expect(await readdir(join(root, '.maple/inpaint'))).toHaveLength(2);
    expect(await readFile(join(root, 'photo.dng'))).toEqual(await readFile(fixture));
    expect(failures).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
