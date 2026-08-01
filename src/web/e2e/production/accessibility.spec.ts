import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/production-test';
import { installProductionFolderPicker } from '../support/production-folder-picker';
import type { ProductionFolderPickerAudit } from '../support/production-folder-picker';
import { readProductionFixtureManifest } from '../support/production-fixtures';

const TARGET = 'test_0006.DNG';
const OTHER_ASSET = 'test_0008.RAF';
const TARGET_THUMB_STEM = createHash('sha256').update(TARGET).digest('hex').slice(0, 16);
const TARGET_THUMB_PATTERN = new RegExp(`^\\.maple/thumbs/${TARGET_THUMB_STEM}\\.(?:avif|jpg)$`);

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, hasFilmstrip: true },
  { name: 'tablet', width: 800, height: 1024, hasFilmstrip: true },
  { name: 'phone', width: 390, height: 844, hasFilmstrip: false },
] as const;

async function tabTo(page: Page, target: Locator, limit = 40): Promise<void> {
  for (let attempt = 0; attempt < limit; attempt++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  await expect(target).toBeFocused();
}

async function openFolderWithKeyboard(page: Page): Promise<void> {
  await page.goto('/');
  const openFolder = page.getByRole('button', { name: /open a folder/i });
  await tabTo(page, openFolder);
  await expect(openFolder).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/browse$/);
  await expect(page.getByRole('button', { name: TARGET, exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

async function waitForThumbnail(page: Page): Promise<void> {
  const image = page.getByRole('button', { name: TARGET, exact: true }).locator('img');
  await expect(image).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(0);
}

async function focusAssetWithKeyboard(page: Page): Promise<Locator> {
  const asset = page.getByRole('button', { name: TARGET, exact: true });
  await tabTo(page, asset);
  await expect(asset).toBeFocused();
  return asset;
}

async function targetThumbWritePath(picker: ProductionFolderPickerAudit): Promise<string> {
  let path = '';
  await expect
    .poll(
      () => {
        path =
          picker.operations.find(
            ({ kind, path: candidate }) => kind === 'write' && TARGET_THUMB_PATTERN.test(candidate),
          )?.path ?? '';
        return path;
      },
      { timeout: 60_000 },
    )
    .toMatch(TARGET_THUMB_PATTERN);
  return path;
}

async function expectVisibleFocusIndicator(asset: Locator): Promise<void> {
  const focusState = () =>
    asset.evaluate((button) => {
      const ring = button.querySelector<HTMLElement>('.thumb-ring');
      const style = ring ? getComputedStyle(ring) : null;
      const colorProbe = document.createElement('span');
      colorProbe.style.color = 'var(--color-primary)';
      ring?.append(colorProbe);
      const targetBorderColor = getComputedStyle(colorProbe).color;
      colorProbe.remove();
      return {
        focusVisible: button.matches(':focus-visible'),
        borderColor: style?.borderTopColor ?? '',
        borderWidth: style?.borderTopWidth ?? '',
        targetBorderColor,
      };
    });

  await expect
    .poll(async () => {
      const focus = await focusState();
      return focus.borderColor === focus.targetBorderColor;
    })
    .toBe(true);

  const focus = await focusState();
  expect(focus.focusVisible).toBe(true);
  expect(focus.borderWidth).toBe('2px');
  expect(focus.borderColor).toBe(focus.targetBorderColor);
}

async function expectSliderAxRange(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    const { nodes } = await session.send('Accessibility.getFullAXTree');
    const slider = nodes.find(
      (node) => node.role?.value === 'slider' && node.name?.value === 'Thumbnail size',
    );
    expect(slider).toBeDefined();
    expect(Number(slider!.value?.value)).toBeGreaterThanOrEqual(60);
    expect(Number(slider!.value?.value)).toBeLessThanOrEqual(220);
    const property = (name: string) =>
      slider!.properties?.find((candidate) => candidate.name === name)?.value?.value;
    expect(property('valuemin')).toBe(60);
    expect(property('valuemax')).toBe(220);
    expect(String(property('valuetext'))).toMatch(/^\d+ pixels$/);
  } finally {
    await session.detach();
  }
}

for (const viewport of VIEWPORTS) {
  test(`Hosted accessibility contract in installed Chrome — ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chrome-hosted');
    test.setTimeout(240_000);
    const manifest = await readProductionFixtureManifest();
    await rm(join(manifest.writableFolder, '.maple'), { recursive: true, force: true });
    const picker = await installProductionFolderPicker(page, manifest.writableFolder);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await openFolderWithKeyboard(page);
    const size = page.getByRole('slider', { name: 'Thumbnail size' });
    await expect(size).toMatchAriaSnapshot(`- slider "Thumbnail size"`);
    await expect(size).toHaveAttribute('min', '60');
    await expect(size).toHaveAttribute('max', '220');
    await expect(size).toHaveAttribute('aria-valuetext', /\d+ pixels/);
    await expectSliderAxRange(page);

    const coldAsset = page.getByRole('button', { name: TARGET, exact: true });
    await expect(coldAsset).toMatchAriaSnapshot(`- button "${TARGET}" [pressed=false]`);
    expect(await coldAsset.ariaSnapshot()).toBe(`- button "${TARGET}"`);
    await expect(coldAsset).toHaveAttribute('aria-pressed', 'false');
    await waitForThumbnail(page);
    const thumbPath = await targetThumbWritePath(picker);

    // Re-open after thumbnail generation: the accessible name and selection
    // contract must not depend on whether the thumbnail is async or cached.
    picker.clear();
    await openFolderWithKeyboard(page);
    await waitForThumbnail(page);
    const warmAsset = await focusAssetWithKeyboard(page);
    await expect(warmAsset).toMatchAriaSnapshot(`- button "${TARGET}" [pressed=false]`);
    expect(await warmAsset.ariaSnapshot()).toBe(`- button "${TARGET}"`);
    await expect(warmAsset).toHaveAttribute('aria-label', TARGET);
    await expect(warmAsset).toHaveAttribute('aria-pressed', 'false');
    await expectVisibleFocusIndicator(warmAsset);
    await expect
      .poll(() => picker.operations.some(({ kind, path }) => kind === 'read' && path === thumbPath))
      .toBe(true);

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/view\//);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page).toHaveURL(/\/edit\//);
    await expect(page.locator('.top-name')).toHaveText(TARGET);

    const filmstrip = page.locator('editor-filmstrip');
    if (viewport.hasFilmstrip) {
      await expect(filmstrip).toBeVisible();
      const targetFilmstripAsset = filmstrip.getByRole('button', { name: TARGET, exact: true });
      const otherFilmstripAsset = filmstrip.getByRole('button', {
        name: OTHER_ASSET,
        exact: true,
      });
      await expect(targetFilmstripAsset).toMatchAriaSnapshot(`- button "${TARGET}" [pressed=true]`);
      await expect(otherFilmstripAsset).toMatchAriaSnapshot(
        `- button "${OTHER_ASSET}" [pressed=false]`,
      );
      await expect(targetFilmstripAsset).toHaveAttribute('aria-current', 'true');
      await expect(otherFilmstripAsset).not.toHaveAttribute('aria-current', 'true');

      await tabTo(page, otherFilmstripAsset);
      await page.keyboard.press('Enter');
      await expect(page.locator('.top-name')).toHaveText(OTHER_ASSET);
      await expect(otherFilmstripAsset).toHaveAttribute('aria-current', 'true');
      await expect(targetFilmstripAsset).not.toHaveAttribute('aria-current', 'true');
      await expect(otherFilmstripAsset).toMatchAriaSnapshot(
        `- button "${OTHER_ASSET}" [pressed=true]`,
      );
      await expect(targetFilmstripAsset).toMatchAriaSnapshot(
        `- button "${TARGET}" [pressed=false]`,
      );
    } else {
      await expect(filmstrip).toHaveCount(0);
      await page.getByRole('button', { name: 'Light', exact: true }).click();
    }

    const exposure = page.getByRole('slider', { name: 'Exposure' });
    await expect(exposure).toBeVisible({ timeout: 60_000 });
    const selectedUrl = page.url();
    await exposure.focus();
    const before = await exposure.getAttribute('aria-valuenow');
    await exposure.press('ArrowRight');
    await expect(exposure).not.toHaveAttribute('aria-valuenow', before ?? '0');
    expect(page.url()).toBe(selectedUrl);
    const selectedAsset = viewport.hasFilmstrip ? OTHER_ASSET : TARGET;
    await expect(page.locator('.top-name')).toHaveText(selectedAsset);
    if (viewport.hasFilmstrip) {
      await expect(
        filmstrip.getByRole('button', { name: selectedAsset, exact: true }),
      ).toHaveAttribute('aria-current', 'true');
    }
  });
}
