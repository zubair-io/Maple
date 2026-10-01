import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const RAW = resolve(__dirname, '../../../test-fixtures/raws/test_0017.dng');
test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgpu',
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    ],
  },
});

async function waitForLiveSession(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        for (const worker of page.workers()) {
          const opened = await Promise.race([
            worker.evaluate(() =>
              performance
                .getEntriesByType('measure')
                .some((entry) => entry.name === 'maple:session-open'),
            ),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
          ]).catch(() => false);
          if (opened) return true;
        }
        return false;
      },
      { timeout: 90_000 },
    )
    .toBe(true);
}

async function downloadXmp(page: Page): Promise<string> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download XMP', exact: true }).click();
  const download = await pending;
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path!, 'utf8');
}

async function renderCount(page: Page): Promise<number> {
  const counts = await Promise.all(
    page.workers().map(async (worker) => {
      return Promise.race([
        worker.evaluate(
          () =>
            performance
              .getEntriesByType('measure')
              .filter((entry) => entry.name === 'maple:session-render').length,
        ),
        new Promise<number>((resolve) => setTimeout(() => resolve(0), 1500)),
      ]).catch(() => 0);
    }),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

test('mask composition edits render live, undo whole gestures, and survive a saved sidecar', async ({
  page,
}, testInfo) => {
  test.skip(!existsSync(RAW), 'The gitignored RAW fixture is unavailable.');
  test.setTimeout(240_000);
  await page.goto('/');
  test.skip(
    !(await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()))),
    'This browser has no WebGPU adapter.',
  );
  await page.locator('input[type="file"]').first().setInputFiles(RAW);
  await expect(page).toHaveURL(/\/edit\//);
  await waitForLiveSession(page);
  expect(await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('before.png') });
  await page.getByRole('button', { name: 'Mask', exact: true }).click();
  await page.getByRole('button', { name: 'Add radial mask', exact: true }).click();
  await expect(page.getByTestId('mask-handle-radialCenter')).toBeVisible();
  await page.getByRole('button', { name: 'subtract linear component', exact: true }).click();
  await expect(page.getByTestId('mask-components').locator('mui-list-row')).toHaveCount(2);
  await expect(page.getByTestId('mask-handle-linearStart')).toBeVisible();
  await expect(page.getByTestId('mask-handle-radialCenter')).toHaveCount(0);

  const controls = page.getByTestId('mask-controls');
  const exposure = controls.getByRole('slider', { name: 'Exposure', exact: true });
  const previousRenders = await renderCount(page);
  await exposure.focus();
  await exposure.press('ArrowRight');
  await expect.poll(() => renderCount(page)).toBeGreaterThan(previousRenders);
  const beforeGesture = await downloadXmp(page);
  const opacity = controls.getByRole('slider', { name: 'Opacity', exact: true });
  const bounds = await opacity.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * 0.8, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.6, bounds!.y + bounds!.height / 2, {
    steps: 8,
  });
  // A pause longer than the history idle debounce still belongs to this held drag.
  await page.waitForTimeout(600);
  await page.mouse.move(bounds!.x + bounds!.width * 0.4, bounds!.y + bounds!.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(opacity).not.toHaveAttribute('aria-valuenow', '1');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(opacity).toHaveAttribute('aria-valuenow', '1');
  expect(await downloadXmp(page)).toBe(beforeGesture);

  await opacity.focus();
  await opacity.press('ArrowLeft');
  await page.getByRole('checkbox', { name: 'Invert component', exact: true }).check();
  const saved = await downloadXmp(page);
  expect(saved).toContain('crs:MaskGroupBasedCorrections');
  expect(saved).toContain('papp:MaskCombine="Subtract"');
  expect(saved).toContain('papp:MaskGroupOpacity="0.99"');
  await page.screenshot({ path: testInfo.outputPath('after.png') });
  const sidecar = testInfo.outputPath('test_0017.xmp');
  await writeFile(sidecar, saved);
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles([RAW, sidecar]);
  await expect(page).toHaveURL(/\/edit\//);
  await waitForLiveSession(page);
  await page.getByRole('button', { name: 'Mask', exact: true }).click();
  await page.getByTestId('mask-row-0').click();
  await expect(page.getByTestId('mask-components').locator('mui-list-row')).toHaveCount(2);
  await page.getByTestId('mask-component-1').click();
  await expect(page.getByRole('checkbox', { name: 'Invert component', exact: true })).toBeChecked();
  await expect(page.getByRole('slider', { name: 'Opacity', exact: true })).toHaveAttribute(
    'aria-valuenow',
    '0.99',
  );
  expect(await downloadXmp(page)).toBe(saved);
});
