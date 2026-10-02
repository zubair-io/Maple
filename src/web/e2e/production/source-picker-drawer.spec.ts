// SourcePickerDrawer — real Browse route and browser pointer-capture coverage (#4028).
import type { Page } from '@playwright/test';
import { test, expect } from '../support/production-test';

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chrome-hosted',
    'Hosted Browse integration of the shared drawer',
  );
});

async function openDrawer(page: Page) {
  await page.goto('/browse');
  await page.getByTestId('source-drawer-toggle').click();
  const drawer = page.getByRole('dialog', { name: 'Library', exact: true });
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  if (!box) throw new Error('drawer has no bounding box');
  return { drawer, box };
}

async function startDrag(page: Page, box: { x: number; y: number; width: number; height: number }) {
  const x = box.x + box.width * 0.75;
  const y = box.y + box.height * 0.75;
  await page.mouse.move(x, y);
  await page.mouse.down();
  return { x, y };
}

for (const width of [320, 375, 430]) {
  test(`drawer uses its rendered 30% swipe threshold at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 812 });
    const { drawer, box } = await openDrawer(page);
    expect(box.width).toBeCloseTo(Math.min(326, width * 0.81), 0);
    await testInfo.attach('drawer-before.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    const start = await startDrag(page, box);
    await page.mouse.move(start.x - box.width * 0.29, start.y, { steps: 8 });
    await page.mouse.up();
    await expect(drawer).toBeVisible();
    await expect.poll(() => drawer.evaluate((el) => el.getBoundingClientRect().x)).toBe(0);

    const next = await startDrag(page, box);
    await page.mouse.move(next.x - box.width * 0.31, next.y, { steps: 8 });
    await page.mouse.up();
    await expect(drawer).not.toBeVisible();
    await testInfo.attach('drawer-after.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
}

test('drawer dims using its actual visible width and ignores rightward motion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 812 });
  const { drawer, box } = await openDrawer(page);
  const start = await startDrag(page, box);
  await page.mouse.move(start.x - box.width * 0.25, start.y, { steps: 8 });
  const scrim = page.locator('app-source-picker-drawer .scrim');
  await expect
    .poll(() => scrim.evaluate((el) => Number((el as HTMLElement).style.opacity)))
    .toBeCloseTo(0.45 * 0.75, 2);
  await page.mouse.up();
  await expect(drawer).toBeVisible();
  await expect.poll(() => drawer.evaluate((el) => el.getBoundingClientRect().x)).toBe(0);

  const next = await startDrag(page, box);
  await page.mouse.move(next.x + box.width * 0.1, next.y, { steps: 8 });
  await expect.poll(() => drawer.evaluate((el) => el.getBoundingClientRect().x)).toBe(0);
  await expect
    .poll(() => scrim.evaluate((el) => Number((el as HTMLElement).style.opacity)))
    .toBe(0.45);
  await page.mouse.up();
  await expect(drawer).toBeVisible();
  await page.getByRole('button', { name: 'Close library', exact: true }).click();
  await expect(drawer).not.toBeVisible();
});

test('drawer close button retains its native pointer click', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { drawer } = await openDrawer(page);
  await page.getByRole('button', { name: 'Close library', exact: true }).click();
  await expect(drawer).not.toBeVisible();
});
