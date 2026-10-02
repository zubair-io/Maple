import type { Page } from '@playwright/test';
import { expect, test } from '../support/production-test';
import { RESOLVED_PREVIEW_SELECTOR } from '../support/preview-surface';

import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProductionFixtureManifest } from '../support/production-fixtures';
import { installProductionFolderPicker } from '../support/production-folder-picker';

let fixtureDirectory: string;
let source: { path: string; sha256: string };

test.beforeAll(async ({}, testInfo) => {
  if (testInfo.project.name !== 'chrome-hosted') return;
  const manifest = await readProductionFixtureManifest();
  const raw = manifest.sourceHashes.find(({ path }) => path.endsWith('/test_0006.DNG'));
  if (!raw) throw new Error('Preview gesture qualification requires test_0006.DNG');
  source = raw;
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'maple-preview-gestures-'));
  await copyFile(source.path, join(fixtureDirectory, 'first.DNG'));
  await copyFile(source.path, join(fixtureDirectory, 'second.DNG'));
});

test.afterAll(async ({}, testInfo) => {
  if (testInfo.project.name !== 'chrome-hosted' || !fixtureDirectory) return;
  try {
    for (const path of [
      source.path,
      join(fixtureDirectory, 'first.DNG'),
      join(fixtureDirectory, 'second.DNG'),
    ]) {
      expect(
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ).toBe(source.sha256);
    }
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

// Actual RAW copies, browser codecs, Browse and Preview. The chooser bridge
// reads/writes real files; OS picker permissions are qualified separately.
async function openPreview(page: Page, width = 375) {
  await page.setViewportSize({ width, height: 812 });
  await installProductionFolderPicker(page, fixtureDirectory);
  await page.goto('/');
  await page.getByRole('button', { name: /open a folder/i }).click();
  await expect(page.getByRole('button', { name: 'first.DNG', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'first.DNG', exact: true }).click();
  await expect(page.getByTestId('preview-filename')).toHaveText('first.DNG');
  const image = page.locator(RESOLVED_PREVIEW_SELECTOR);
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  const box = await image.boundingBox();
  if (!box) throw new Error('loaded preview has no bounds');
  return { x: box.x + box.width * 0.75, y: box.y + box.height / 2 };
}

async function mouseSwipe(page: Page, x: number, y: number, dx: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chrome-hosted',
    'Hosted real filesystem preview integration',
  );
});

test('loaded preview images support native mouse next and previous swipes', async ({ page }) => {
  const { x, y } = await openPreview(page);
  await mouseSwipe(page, x, y, -60);
  await expect(page.getByTestId('preview-filename')).toHaveText('second.DNG');
  await mouseSwipe(page, x - 60, y, 60);
  await expect(page.getByTestId('preview-filename')).toHaveText('first.DNG');
});

test('preview completes a captured swipe released over the filmstrip', async ({ page }) => {
  const { x, y } = await openPreview(page, 800);
  const rail = await page.locator('.preview-filmstrip-rail').boundingBox();
  if (!rail) throw new Error('filmstrip has no bounds');
  const end = { x: rail.x + rail.width / 2, y: rail.y + rail.height / 2 };
  expect(
    await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.preview-filmstrip-rail'),
      end,
    ),
  ).toBe(true);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('preview-filename')).toHaveText('second.DNG');
});

test('preview ignores right-button and short movements before the next swipe', async ({ page }) => {
  const { x, y } = await openPreview(page);
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x - 60, y, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('preview-filename')).toHaveText('first.DNG');
  await mouseSwipe(page, x, y, -15);
  await expect(page.getByTestId('preview-filename')).toHaveText('first.DNG');
  await mouseSwipe(page, x, y, -60);
  await expect(page.getByTestId('preview-filename')).toHaveText('second.DNG');
});

test('native touch cancellation and vertical motion preserve the next horizontal swipe', async ({
  page,
}) => {
  const { x, y } = await openPreview(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x - 60, y }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(page.getByTestId('preview-filename')).toHaveText('first.DNG');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x - 60, y: y + 90 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByTestId('preview-filename')).toHaveText('first.DNG');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x - 20, y }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x - 60, y }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByTestId('preview-filename')).toHaveText('second.DNG');
  } finally {
    await cdp.detach();
  }
});

test('a secondary touch cannot page and a new primary touch still can', async ({ page }) => {
  const { x, y } = await openPreview(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x, y, id: 1 },
        { x: x + 30, y, id: 2 },
      ],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: x - 60, y, id: 1 },
        { x: x - 30, y, id: 2 },
      ],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByTestId('preview-filename')).toHaveText('first.DNG');
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x - 20, y, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x - 60, y, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByTestId('preview-filename')).toHaveText('second.DNG');
  } finally {
    await cdp.detach();
  }
});

test('keyboard navigation cancels a gesture from the previous photo', async ({ page }) => {
  const { x, y } = await openPreview(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('preview-filename')).toHaveText('second.DNG');
  await page.mouse.move(x - 60, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('preview-filename')).toHaveText('second.DNG');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('preview-filename')).toHaveText('first.DNG');
});

for (const width of [375, 800, 1280]) {
  test(`Preview action targets do not overlap at ${width}px`, async ({ page }) => {
    await openPreview(page, width);
    const actions = page.locator(width < 768 ? '.preview-top-actions' : '.preview-action-bar');
    const controls = [page.getByRole('button', { name: 'Back', exact: true })];
    for (const label of ['Flag', 'Edit', 'Info'])
      controls.push(actions.getByRole('button', { name: label, exact: true }));
    const boxes = [];
    for (const control of controls) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      if (!box) throw new Error('Preview action has no bounds');
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      boxes.push(box);
    }
    for (let i = width < 768 ? 1 : 2; i < boxes.length; i++)
      expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: test.info().outputPath(`preview-actions-${width}.png`) });
  });

  test(`Preview native actions retain keyboard and disclosure behavior at ${width}px`, async ({
    page,
  }) => {
    await openPreview(page, width);
    const actions = page.locator(width < 768 ? '.preview-top-actions' : '.preview-action-bar');
    const photo = page.locator('editor-filmstrip button').first();
    await photo.focus();
    await expect(photo).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('preview-filename')).toHaveText('second.DNG');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('preview-filename')).toHaveText('first.DNG');
    const flag = actions.getByRole('button', { name: 'Flag', exact: true });
    const info = actions.getByRole('button', { name: 'Info', exact: true });
    const edit = actions.getByRole('button', { name: 'Edit', exact: true });
    await flag.focus();
    await expect(flag).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('preview-filename')).toHaveText('first.DNG');
    await expect(flag).not.toHaveAttribute('aria-pressed');
    await page.keyboard.press('Enter');
    await expect(flag).toHaveAttribute('aria-expanded', 'true');
    const controlled = await flag.getAttribute('aria-controls');
    expect(controlled).toBe('preview-flag-popover');
    await expect(page.locator('#' + controlled)).toBeVisible();
    await page.keyboard.press('Space');
    await expect(flag).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#' + controlled)).toHaveCount(0);
    await expect(edit).not.toHaveAttribute('aria-pressed');
    await info.focus();
    await expect(info).toBeFocused();
    const wasOpen = (await info.getAttribute('aria-pressed')) === 'true';
    await page.keyboard.press('Space');
    await expect(info).toHaveAttribute('aria-pressed', String(!wasOpen));
    if (width < 768) {
      await expect(page.getByTestId('bottom-sheet')).toBeVisible();
      await page
        .getByTestId('bottom-sheet')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await expect(info).toHaveAttribute('aria-pressed', 'false');
    } else {
      await expect(page.locator('.info-pane')).toHaveCount(wasOpen ? 0 : 1);
    }
    await page.getByRole('button', { name: 'Back', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/browse/);
    await page.getByRole('button', { name: 'first.DNG', exact: true }).click();
    await actions.getByRole('button', { name: 'Edit', exact: true }).focus();
    await expect(actions.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/edit\//);
  });
}
