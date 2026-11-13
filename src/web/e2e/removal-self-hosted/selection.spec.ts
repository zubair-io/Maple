// #3984: actual local segmentation/detection over an authenticated server RAW.
// This photographic selection gate does not qualify reconstruction quality.
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdtemp, copyFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openSelfHostedFixture } from '../support/self-hosted-production';

const fixture = resolve(__dirname, '../../../../test-fixtures/raws/test_0002.dng');
const modelRoot = process.env.MAPLE_REMOVAL_MODEL_DIR ?? '/tmp/maple-removal-models';
const sam = [
  join(modelRoot, 'mobile-sam/native-build/mobile-sam-encoder.onnx'),
  join(modelRoot, 'mobile-sam/native-build/mobile-sam-decoder.onnx'),
];

async function openPortrait(page: Page, info: TestInfo, people: boolean) {
  const runtime = JSON.parse(
    await readFile(
      resolve(__dirname, '../../test-results/removal-self-hosted-runtime.json'),
      'utf8',
    ),
  ) as { root: string };
  const root = await mkdtemp(join(runtime.root, 'selection-'));
  await copyFile(fixture, join(root, 'portrait.dng'));
  await openSelfHostedFixture(
    page,
    root,
    `Server ${people ? 'People' : 'Smart'} ${info.project.name}`,
  );
  await page.getByRole('button', { name: 'portrait.dng', exact: true }).click();
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  if (info.project.name === 'server-removal-webgpu')
    await expect(page.locator('canvas[data-gpu-live]')).toBeVisible({ timeout: 60_000 });
  else await expect(page.locator('canvas[data-gpu-live]')).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Editor tools' })
    .getByRole('button', { name: 'Remove', exact: true })
    .click();
  const panel = page.getByTestId('removal-panel');
  await panel.getByText('Local AI models', { exact: true }).click();
  await panel
    .getByLabel('Import local removal models')
    .setInputFiles(
      people ? [...sam, join(modelRoot, 'rtdetr/native-build/rtdetrv2-r18.onnx')] : sam,
    );
  await expect(
    panel.getByText(`${people ? 'rtdetrv2-r18' : 'mobile-sam-decoder'}.onnx · Installed`, {
      exact: false,
    }),
  ).toBeVisible();
  await panel
    .getByRole('combobox', { name: 'Object selection mode', exact: true })
    .selectOption(people ? 'people' : 'smart');
  return { root, panel };
}

async function unchanged(root: string) {
  expect(await readdir(root)).not.toContain('portrait.xmp');
  await expect(readdir(join(root, '.maple/inpaint'))).rejects.toThrow();
  expect(await readFile(join(root, 'portrait.dng'))).toEqual(await readFile(fixture));
}

test('Smart paint on a server RAW preserves accepted intent when a negative prompt fails', async ({
  page,
}, info) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  const { root, panel } = await openPortrait(page, info, false);
  try {
    await expect(panel.getByRole('slider', { name: 'Brush size', exact: true })).toBeEnabled();
    const overlay = page.getByRole('img', { name: /Paint to select objects/ });
    await expect(overlay).toHaveAttribute('aria-disabled', 'false');
    const rect = await overlay.boundingBox();
    if (!rect) throw Error('Smart paint has no canvas bounds');
    const middle = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    await page.mouse.move(middle.x - 4, middle.y);
    await page.mouse.down();
    await page.mouse.move(middle.x + 4, middle.y, { steps: 3 });
    await page.mouse.up();
    const undo = panel.getByRole('button', { name: 'Undo selection stroke', exact: true });
    const redo = panel.getByRole('button', { name: 'Redo selection stroke', exact: true });
    const clear = panel.getByRole('button', { name: 'Clear selection', exact: true });
    await expect(undo).toBeEnabled({ timeout: 120_000 });
    await expect(clear).toBeEnabled();
    await page.screenshot({ path: info.outputPath('server-smart-selection.png') });
    await panel.getByRole('button', { name: 'Paint to subtract selection', exact: true }).click();
    await page.mouse.click(rect.x + rect.width * 0.57, rect.y + rect.height * 0.6);
    await expect(
      panel.getByRole('status').filter({
        hasText: 'smart selection: no candidate honors the positive and negative prompts',
      }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
    await expect(clear).toBeEnabled();
    await undo.click();
    await expect(redo).toBeEnabled();
    await expect(clear).toBeDisabled();
    await redo.click();
    await expect(undo).toBeEnabled();
    await expect(clear).toBeEnabled();
    await unchanged(root);
    expect(failures).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('People on a server RAW protects the likely subject and permits explicit override and refinement', async ({
  page,
}, info) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  const { root, panel } = await openPortrait(page, info, true);
  try {
    const suggest = panel.getByRole('button', { name: 'Suggest background people', exact: true });
    await expect(suggest).toBeEnabled();
    await suggest.click();
    const keep = panel.getByRole('button', {
      name: 'Person 1 · Keep · Likely subject',
      exact: true,
    });
    await expect(keep).toHaveAttribute('aria-pressed', 'true', { timeout: 120_000 });
    const apply = panel.getByRole('button', { name: 'Apply person choices', exact: true });
    await expect(apply).toBeEnabled({ timeout: 120_000 });
    await expect(panel.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
    await expect(
      panel.getByRole('button', { name: 'Clear protection', exact: true }),
    ).toBeEnabled();
    await page.screenshot({ path: info.outputPath('server-people-subject-protection.png') });
    await keep.click();
    await expect(
      panel.getByRole('button', { name: 'Person 1 · Remove · Likely subject', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await apply.click();
    await expect(panel.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled({
      timeout: 120_000,
    });
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
    await unchanged(root);
    expect(failures).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
