import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../support/production-test';
import { openDisposableHostedEditor, sha256File } from '../support/production-editor-actions';

const filename = 'test_0006.DNG';
const sidecarName = 'test_0006.xmp';
const descriptorName = '.maple/previews/test_0006.DNG.preview.json';
const expectedSaveError = `XmpStoreService: write failed for ${filename}:`;

function fingerprint(xml: string): string {
  return createHash('sha256').update(xml).digest('hex');
}

async function readDescriptor(folder: string): Promise<{ sidecarFingerprint: string }> {
  return JSON.parse(await readFile(join(folder, descriptorName), 'utf8')) as {
    sidecarFingerprint: string;
  };
}

async function establishedEdit(
  page: import('@playwright/test').Page,
  folder: string,
): Promise<string> {
  const exposure = page.getByRole('slider', { name: 'Exposure' });
  await expect(exposure).toHaveAttribute('aria-valuenow', '0');
  await exposure.focus();
  await exposure.press('ArrowRight');
  const sidecarPath = join(folder, sidecarName);
  await expect
    .poll(async () => readFile(sidecarPath, 'utf8').catch(() => ''), { timeout: 90_000 })
    .toContain('crs:Exposure2012=');
  const xml = await readFile(sidecarPath, 'utf8');
  await expect
    .poll(async () => (await readDescriptor(folder).catch(() => null))?.sidecarFingerprint, {
      timeout: 90_000,
    })
    .toBe(fingerprint(xml));
  return xml;
}

test('Hosted skips a developed preview when the edit cannot be saved to its real XMP', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  testInfo.annotations.push({ type: 'expected-console-error', description: expectedSaveError });
  const { folder, rawPath, originalHash, picker } = await openDisposableHostedEditor(
    page,
    'preview-unsaved-xmp',
  );
  const beforeXml = await establishedEdit(page, folder);
  const beforeDescriptor = await readFile(join(folder, descriptorName), 'utf8');
  picker.setDeniedWritePaths([sidecarName]);
  picker.clear();
  const exposure = page.getByRole('slider', { name: 'Exposure' });
  await exposure.press('ArrowRight');
  await expect(page.getByRole('alert')).toContainText('Edits are not saved');
  // The preview writer's real sidecar read follows its separate idle debounce.
  picker.clear();
  await expect
    .poll(
      () => picker.operations.some(({ kind, path }) => kind === 'read' && path === sidecarName),
      { timeout: 90_000 },
    )
    .toBe(true);
  await page.waitForTimeout(250);
  expect(
    picker.operations.some(({ kind, path }) => kind === 'write' && path === descriptorName),
  ).toBe(false);
  expect(await readFile(join(folder, descriptorName), 'utf8')).toBe(beforeDescriptor);
  expect(await readFile(join(folder, sidecarName), 'utf8')).toBe(beforeXml);
  expect(await sha256File(rawPath)).toBe(originalHash);
});

test('Hosted skips a developed preview when a real XMP changes outside Maple', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  testInfo.annotations.push({ type: 'expected-console-error', description: expectedSaveError });
  const { folder, rawPath, originalHash, picker } = await openDisposableHostedEditor(
    page,
    'preview-external-xmp',
  );
  const beforeXml = await establishedEdit(page, folder);
  const beforeDescriptor = await readFile(join(folder, descriptorName), 'utf8');
  const externalXml = beforeXml.replace(/crs:Exposure2012="[^"]+"/, 'crs:Exposure2012="1.25"');
  expect(externalXml).not.toBe(beforeXml);
  await writeFile(join(folder, sidecarName), externalXml);
  picker.clear();
  const exposure = page.getByRole('slider', { name: 'Exposure' });
  await exposure.press('ArrowRight');
  await expect(page.getByRole('alert')).toContainText('Edits are not saved');
  picker.clear();
  await expect
    .poll(
      () => picker.operations.some(({ kind, path }) => kind === 'read' && path === sidecarName),
      { timeout: 90_000 },
    )
    .toBe(true);
  await page.waitForTimeout(250);
  expect(
    picker.operations.some(({ kind, path }) => kind === 'write' && path === descriptorName),
  ).toBe(false);
  expect(await readFile(join(folder, descriptorName), 'utf8')).toBe(beforeDescriptor);
  expect(await readFile(join(folder, sidecarName), 'utf8')).toBe(externalXml);
  expect(await sha256File(rawPath)).toBe(originalHash);
});
