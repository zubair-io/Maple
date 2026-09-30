import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gatePng } from './support/gate-image';

async function openGeometry(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'guides.png',
      mimeType: 'image/png',
      buffer: gatePng(1024),
    });
  await page.waitForURL(/\/edit\//);
  await page.getByRole('button', { name: 'Geometry', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Vertical', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Four guides', exact: true })).toBeEnabled();
}

async function draw(page: Page, lines: number[][]): Promise<void> {
  const overlay = page.getByRole('application', { name: 'Draw geometry guides' });
  await expect(overlay).toBeVisible();
  const box = (await overlay.boundingBox())!;
  // The square fixture is fit-centred in the shared crop footprint.
  const size = Math.min(box.width, box.height, 1024);
  const left = box.x + (box.width - size) / 2;
  const top = box.y + (box.height - size) / 2;
  for (const [x1, y1, x2, y2] of lines) {
    await page.mouse.move(left + x1 * size, top + y1 * size);
    await page.mouse.down();
    await page.mouse.move(left + x2 * size, top + y2 * size, { steps: 8 });
    await page.mouse.up();
  }
}

test('four guides use the WASM solver, persist ordinary XMP and undo in one step', async ({
  page,
}) => {
  await openGeometry(page);
  await page.getByRole('button', { name: 'Four guides', exact: true }).click();
  const inverse = (x: number, y: number): number[] => {
    const angle = (4 * Math.PI) / 180;
    const rx = x * Math.cos(angle) + y * Math.sin(angle);
    const ry = -x * Math.sin(angle) + y * Math.cos(angle);
    const d = 1 - 0.09 * rx + 0.125 * ry;
    return [(rx / d + 1) / 2, (ry / d + 1) / 2];
  };
  const lines = [
    [-0.45, -0.5, -0.45, 0.5],
    [0.45, -0.5, 0.45, 0.5],
    [-0.5, -0.4, 0.5, -0.4],
    [-0.5, 0.4, 0.5, 0.4],
  ].map(([x1, y1, x2, y2]) => [...inverse(x1, y1), ...inverse(x2, y2)]);
  await draw(page, lines.slice(0, 2));
  await expect(page.getByRole('button', { name: 'Apply guides' })).toBeDisabled();
  await draw(page, lines.slice(2));
  await page.screenshot({ path: test.info().outputPath('guides-before.png') });
  await page.getByRole('button', { name: 'Apply guides' }).click();
  const vertical = page.getByRole('slider', { name: 'Vertical', exact: true });
  await expect
    .poll(async () => Number(await vertical.getAttribute('aria-valuenow')))
    .toBeCloseTo(-25, 1);
  expect(
    Number(
      await page
        .getByRole('slider', { name: 'Horizontal', exact: true })
        .getAttribute('aria-valuenow'),
    ),
  ).toBeCloseTo(18, 1);
  expect(
    Number(
      await page.getByRole('slider', { name: 'Rotate', exact: true }).getAttribute('aria-valuenow'),
    ),
  ).toBeCloseTo(4, 1);
  const saving = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download XMP', exact: true }).click();
  const xml = await readFile((await (await saving).path())!, 'utf8');
  const attribute = (key: string) => Number(xml.match(new RegExp(`crs:${key}="([^"]+)"`))?.[1]);
  expect(attribute('PerspectiveVertical')).toBeCloseTo(-25, 1);
  expect(attribute('PerspectiveHorizontal')).toBeCloseTo(18, 1);
  expect(attribute('PerspectiveRotate')).toBeCloseTo(4, 1);
  expect(xml).not.toContain('GuideLine');
  await page.screenshot({ path: test.info().outputPath('guides-after.png') });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(vertical).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByRole('slider', { name: 'Horizontal', exact: true })).toHaveAttribute(
    'aria-valuenow',
    '0',
  );
  await expect(page.getByRole('slider', { name: 'Rotate', exact: true })).toHaveAttribute(
    'aria-valuenow',
    '0',
  );
});

test('parallel horizons only level, and Escape cancels transient guides', async ({ page }) => {
  await openGeometry(page);
  await page.getByRole('button', { name: 'Guide horizontals' }).click();
  await draw(page, [
    [0.2, 0.3, 0.8, 0.34],
    [0.2, 0.65, 0.8, 0.69],
  ]);
  await page.getByRole('button', { name: 'Apply guides' }).click();
  const rotate = page.getByRole('slider', { name: 'Rotate', exact: true });
  await expect
    .poll(async () => Number(await rotate.getAttribute('aria-valuenow')))
    .toBeCloseTo(-3.814, 1);
  expect(
    Number(
      await page
        .getByRole('slider', { name: 'Vertical', exact: true })
        .getAttribute('aria-valuenow'),
    ),
  ).toBeCloseTo(0, 3);
  expect(
    Number(
      await page
        .getByRole('slider', { name: 'Horizontal', exact: true })
        .getAttribute('aria-valuenow'),
    ),
  ).toBeCloseTo(0, 3);
  await page.getByRole('button', { name: 'Guide verticals' }).click();
  await page.getByRole('application', { name: 'Draw geometry guides' }).press('Escape');
  await expect(page.getByRole('application', { name: 'Draw geometry guides' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(rotate).toHaveAttribute('aria-valuenow', '0');
});

test('keyboard endpoints can author and apply a guided horizon', async ({ page }) => {
  await openGeometry(page);
  await page.getByRole('button', { name: 'Guide horizontals' }).click();
  const overlay = page.getByRole('application', { name: 'Draw geometry guides' });
  await expect(overlay).toBeFocused();
  const move = async (key: string, count: number) => {
    for (let i = 0; i < count; i++) await overlay.press(`Shift+${key}`);
  };
  await move('ArrowLeft', 10);
  await move('ArrowUp', 10);
  await overlay.press('Enter');
  await move('ArrowRight', 20);
  await move('ArrowDown', 1);
  await overlay.press('Enter');
  await move('ArrowLeft', 20);
  await move('ArrowDown', 30);
  await overlay.press('Enter');
  await move('ArrowRight', 20);
  await move('ArrowDown', 1);
  await overlay.press('Enter');
  await page.getByRole('button', { name: 'Apply guides' }).click();
  await expect
    .poll(async () =>
      Number(
        await page
          .getByRole('slider', { name: 'Rotate', exact: true })
          .getAttribute('aria-valuenow'),
      ),
    )
    .toBeCloseTo(-2.862, 1);
});
