// color-curves-ui.spec.ts — the Oklab secondary Color Curves UI in the real
// Hosted editor (#5077): mode switch, six curve pills, ribbon editing, skin-
// tone anchors and the stage-input eyedropper, in installed Chrome against the
// built bundle with the generated gate image.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from '../support/production-test';
import { writeGatePng } from '../support/gate-image';

const CURVES = ['hueVsHue', 'hueVsSat', 'hueVsLuma', 'lumaVsSat', 'satVsSat', 'satVsLuma'] as const;

function hostedOnly(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== 'chrome-hosted');
}

const RAW_FIXTURE = resolve(__dirname, '../../../../test-fixtures/raws/test_0013.DNG');

async function openColorCurves(page: Page, file?: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles(file ?? (await writeGatePng()));
  await page.waitForURL(/\/edit\//, { timeout: 30_000 });
  await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Decoding RAW')).toHaveCount(0, { timeout: 120_000 });

  await page
    .getByRole('navigation', { name: 'Editor tools' })
    .getByRole('button', { name: 'Color', exact: true })
    .click();
  await page.getByText('HSL', { exact: true }).click();
  await page.getByTestId('hsl-mode-curves').click();
  await expect(page.getByTestId('color-curves-panel')).toBeVisible();
}

async function ribbonBox(page: Page) {
  const box = await page.getByTestId('color-curve-ribbon').boundingBox();
  expect(box, 'ribbon has a layout box').not.toBeNull();
  return box!;
}

test('mode switch, six curve pills and ribbon knot editing', async ({ page }, testInfo) => {
  hostedOnly(testInfo);
  await openColorCurves(page);

  for (const id of CURVES) {
    await expect(page.getByTestId(`color-curve-pill-${id}`)).toBeVisible();
  }
  await page.getByTestId('color-curve-pill-hueVsSat').click();
  await expect(page.getByTestId('color-curve-pill-hueVsSat')).toHaveAttribute(
    'aria-selected',
    'true',
  );

  const box = await ribbonBox(page);
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await expect(page.getByTestId('color-curve-knot-0')).toBeVisible();
  await expect(page.getByTestId('color-curve-pill-hueVsSat').locator('.mod-dot')).toBeVisible();

  await page.getByTestId('color-curve-knot-0').dblclick();
  await expect(page.getByTestId('color-curve-knot-0')).toHaveCount(0);

  await page.getByTestId('color-curve-pill-lumaVsSat').click();
  await expect(page.getByTestId('color-curve-lock-skin')).toHaveCount(0);
  await testInfo.attach('color-curves.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('lock skin tone drops guard knots at 38, 55 and 72 degrees on hue curves', async ({
  page,
}, testInfo) => {
  hostedOnly(testInfo);
  await openColorCurves(page);
  await page.getByTestId('color-curve-pill-hueVsHue').click();
  await page.getByTestId('color-curve-lock-skin').click();
  await expect(page.locator('[data-testid^="color-curve-knot-"]')).toHaveCount(3);

  const box = await ribbonBox(page);
  const centres = await page.locator('[data-testid^="color-curve-knot-"]').evaluateAll((knots) =>
    knots.map((k) => {
      const rect = (k as HTMLElement).getBoundingClientRect();
      return rect.left + rect.width / 2;
    }),
  );
  const expected = [38, 55, 72].map((deg) => box.x + (deg / 360) * box.width);
  centres
    .sort((a, b) => a - b)
    .forEach((centre, i) => expect(Math.abs(centre - expected[i])).toBeLessThan(3));

  await page.getByTestId('color-curve-reset').click();
  await expect(page.locator('[data-testid^="color-curve-knot-"]')).toHaveCount(0);
});

async function armEyedropperAndClick(page: Page, x: number, y: number): Promise<void> {
  await page.getByTestId('color-curve-pill-hueVsSat').click();
  await page.getByTestId('color-curve-eyedropper').click();
  await expect(page.getByTestId('color-curve-eyedropper')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(x, y);
  await expect(page.getByTestId('color-curve-eyedropper')).toHaveAttribute(
    'aria-pressed',
    'false',
    { timeout: 30_000 },
  );
}

test('the eyedropper completes on a raster image and says why it cannot sample it', async ({
  page,
}, testInfo) => {
  hostedOnly(testInfo);
  await openColorCurves(page);
  await armEyedropperAndClick(page, 700, 470);
  await expect(page.getByTestId('color-curve-sample-msg')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('color-curve-knot-0')).toHaveCount(0);
});

test('the eyedropper samples a rotated RAW at the stage input and drops an anchor', async ({
  page,
}, testInfo) => {
  hostedOnly(testInfo);
  test.skip(
    !existsSync(RAW_FIXTURE),
    `Fixture ${RAW_FIXTURE} missing (RAW fixtures are gitignored)`,
  );
  test.setTimeout(240_000);
  await openColorCurves(page, RAW_FIXTURE);
  await armEyedropperAndClick(page, 620, 200);
  const knot = page.getByTestId('color-curve-knot-0');
  await expect(knot).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('color-curve-sample-msg')).toHaveCount(0);
  const leftPercent = await knot.evaluate((el) => parseFloat((el as HTMLElement).style.left));
  expect(
    leftPercent,
    'blue sky samples near Oklab hue 250 degrees, not the ground below',
  ).toBeGreaterThan(60);
  expect(leftPercent).toBeLessThan(80);
  await testInfo.attach('eyedropper.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
