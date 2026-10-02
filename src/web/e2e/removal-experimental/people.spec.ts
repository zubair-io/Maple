// Actual photographic selection workflow, not broad subject/quality qualification.
// This local gate requires the pinned models and test_0002.dng corpus, like the
// neighboring actual-model experiment. Missing artifacts fail; they do not qualify.
import { test, expect } from '@playwright/test';
import { mkdtemp, copyFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installProductionFolderPicker } from '../support/production-folder-picker';

const fixture = resolve(__dirname, '../../../../test-fixtures/raws/test_0002.dng');
const modelRoot = process.env.MAPLE_REMOVAL_MODEL_DIR ?? '/tmp/maple-removal-models';
const models = [
  join(modelRoot, 'mobile-sam/native-build/mobile-sam-encoder.onnx'),
  join(modelRoot, 'mobile-sam/native-build/mobile-sam-decoder.onnx'),
  join(modelRoot, 'rtdetr/native-build/rtdetrv2-r18.onnx'),
];

test('Background people automatically keeps the portrait subject and permits review overrides', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const root = await mkdtemp(join(tmpdir(), 'maple-removal-people-ui-'));
  const original = await readFile(fixture);
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  try {
    await copyFile(fixture, join(root, 'portrait.dng'));
    await installProductionFolderPicker(page, root);
    await page.goto('/');
    await page.getByRole('button', { name: /open a folder/i }).click();
    await page.getByRole('button', { name: 'portrait.dng', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    if (testInfo.project.name === 'removal-webgpu')
      await expect(page.locator('canvas[data-gpu-live]')).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Editor tools' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    const panel = page.getByTestId('removal-panel');
    await panel.getByText('Local AI models', { exact: true }).click();
    await panel.getByLabel('Import local removal models').setInputFiles(models);
    await expect(panel.getByText('rtdetrv2-r18.onnx · Installed', { exact: false })).toBeVisible();
    await panel.getByRole('radio', { name: 'Background people', exact: true }).click();
    const suggest = panel.getByRole('button', { name: 'Suggest background people', exact: true });
    await expect(suggest).toBeEnabled();
    await suggest.click();
    const keep = panel.getByRole('button', {
      name: 'Person 1 · Keep · Likely subject',
      exact: true,
    });
    await expect(keep).toBeVisible({ timeout: 120_000 });
    const apply = panel.getByRole('button', { name: 'Apply person choices', exact: true });
    await expect(apply).toBeEnabled({ timeout: 120_000 });
    await expect(keep).toHaveAttribute('aria-pressed', 'true');
    const remove = panel.getByRole('button', { name: 'Remove', exact: true });
    await expect(remove).toBeDisabled();
    await expect(
      panel.getByRole('button', { name: 'Clear protection', exact: true }),
    ).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('automatic-subject-protection.png') });
    // The photographer can deliberately override the suggestion. This only
    // selects a mask; native large-portrait reconstruction is not qualified here.
    await keep.click();
    await expect(
      panel.getByRole('button', { name: 'Person 1 · Remove · Likely subject', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await apply.click();
    await expect(remove).toBeEnabled({ timeout: 120_000 });
    await page.screenshot({ path: testInfo.outputPath('subject-override-selection.png') });
    await panel
      .getByRole('button', { name: 'Person 1 · Remove · Likely subject', exact: true })
      .click();
    await apply.click();
    await expect(apply).toBeEnabled({ timeout: 120_000 });
    await expect(remove).toBeDisabled();
    expect(await readdir(root)).not.toContain('portrait.xmp');
    expect(await readFile(join(root, 'portrait.dng'))).toEqual(original);
    expect(failures).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
