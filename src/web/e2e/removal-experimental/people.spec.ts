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
    await page.addInitScript(() => {
      const digests: Promise<string>[] = [];
      Object.defineProperty(window, '__maplePersonRefinementDigests', { value: digests });
      const Original = window.Worker;
      window.Worker = new Proxy(Original, {
        construct(target, args) {
          const worker = Reflect.construct(target, args) as Worker;
          worker.addEventListener('message', ({ data }) => {
            if (data?.type === 'removal-authoring-success' && data.value?.kind === 'selection')
              digests.push(
                crypto.subtle
                  .digest('SHA-256', data.value.mask)
                  .then((bytes) =>
                    Array.from(new Uint8Array(bytes), (byte) =>
                      byte.toString(16).padStart(2, '0'),
                    ).join(''),
                  ),
              );
          });
          return worker;
        },
      });
    });
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
    await panel
      .getByRole('combobox', { name: 'Object selection mode', exact: true })
      .selectOption('people');
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
    await panel.getByRole('button', { name: 'Refine Person 1', exact: true }).click();
    await panel.getByRole('button', { name: 'Paint to subtract selection', exact: true }).click();
    const overlay = page.getByRole('img', { name: /Paint to select objects/ });
    const rect = await overlay.boundingBox();
    if (!rect) throw Error('People refinement has no canvas bounds');
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const undo = panel.getByRole('button', { name: 'Undo selection stroke', exact: true });
    const redo = panel.getByRole('button', { name: 'Redo selection stroke', exact: true });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(redo).toBeEnabled();
    await redo.click();
    await expect(undo).toBeEnabled();
    const digests = await page.evaluate(async () =>
      Promise.all(Reflect.get(window, '__maplePersonRefinementDigests') as Promise<string>[]),
    );
    expect(digests).toHaveLength(3);
    expect(digests[0]).not.toBe(digests[1]);
    expect(digests[2]).toBe(digests[0]);
    await page.screenshot({ path: testInfo.outputPath('person-manual-refinement.png') });
    await undo.click();
    await expect(redo).toBeEnabled();
    await panel.getByRole('button', { name: 'Done refining', exact: true }).click();
    await expect(panel.getByRole('slider', { name: 'Brush size', exact: true })).toHaveCount(0);
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
