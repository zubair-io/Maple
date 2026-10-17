import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expectProfileCanvas } from './profile-canvas-proof';

const filename = 'test_0013.DNG'; // Physical Rotate90 RAW, 4032 × 3024 sensor.
test('Rotate90 WebGPU canvas agrees with upright native dimensions and overlays', async ({
  page,
}) => {
  test.setTimeout(240000);
  const bytes = readFileSync(resolve('../../test-fixtures/raws', filename));
  await page.route('**/physical-raw/' + filename, (route) =>
    route.fulfill({ body: bytes, contentType: 'application/octet-stream' }),
  );
  await page.goto('http://localhost:4520');
  await page.waitForFunction(() => Reflect.get(window, 'autoFitStatusUI')?.ready);
  const folder = await page.evaluate(
    (filename) => Reflect.get(window, 'autoFitStatusUI').mount([filename], undefined, true),
    filename,
  );
  await expect
    .poll(
      () =>
        page.evaluate(async () => (await Reflect.get(window, 'autoFitStatusUI').state()).gpuActive),
      { timeout: 120000 },
    )
    .toBe(true);
  const dims = await page.evaluate(() =>
    Reflect.get(window, 'autoFitStatusUI').geometry({ profile: 'Neutral' }, 'crop'),
  );
  expect(dims.w).toBeLessThan(dims.h);
  const surface = page.locator('canvas[data-gpu-live]');
  const backing = await surface.evaluate((canvas: HTMLCanvasElement) => ({
    width: canvas.width,
    height: canvas.height,
  }));
  expect(backing.width).toBeLessThan(backing.height);
  expect(backing.width / backing.height).toBeCloseTo(dims.w / dims.h, 2);
  const frame = page.locator('.crop-frame');
  await expect(frame).toBeVisible();
  const crop = await frame.boundingBox();
  const canvas = await surface.boundingBox();
  expect(crop!.width / crop!.height).toBeCloseTo(canvas!.width / canvas!.height, 2);
  const baseline = await pixels(page);
  await page.evaluate(() =>
    Reflect.get(window, 'autoFitStatusUI').geometry(
      {
        localAdjustments: [
          {
            mask: {
              kind: 'radial',
              center: { x: 0.25, y: 0.65 },
              radii: { x: 0.15, y: 0.12 },
              angle: 0,
              feather: 0.5,
              invert: false,
            },
            adjustments: { exposure: -4 },
          },
        ],
      },
      'mask',
    ),
  );
  const masked = await pixels(page);
  const changed = masked.map((value, index) => Math.max(0, baseline[index] - value));
  let weight = 0,
    x = 0,
    y = 0;
  for (let i = 0; i < changed.length; i++) {
    if (i % 4 === 3 || changed[i] < 3) continue;
    const px = Math.floor(i / 4);
    weight += changed[i];
    x += (((px % 64) + 0.5) / 64) * changed[i];
    y += ((Math.floor(px / 64) + 0.5) / 64) * changed[i];
  }
  expect(weight).toBeGreaterThan(100);
  expect(x / weight).toBeCloseTo(0.25, 1);
  expect(y / weight).toBeCloseTo(0.65, 1);
  const handle = await page.getByTestId('mask-handle-radialCenter').boundingBox();
  expect((handle!.x + handle!.width / 2 - canvas!.x) / canvas!.width).toBeCloseTo(0.25, 2);
  expect((handle!.y + handle!.height / 2 - canvas!.y) / canvas!.height).toBeCloseTo(0.65, 2);
  await page.screenshot({ path: 'test-results/orientation/live-mask.png' });
  await page.evaluate(() => Reflect.get(window, 'autoFitStatusUI').dispose());
  await page.evaluate(
    ({ filename, folder }) =>
      Reflect.get(window, 'autoFitStatusUI').mount([filename], folder, false),
    { filename, folder },
  );
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'autoFitStatusUI').dimensions()), {
      timeout: 120000,
    })
    .toEqual(dims);
  await expectProfileCanvas(page, false);
  const reopened = await page.evaluate(() =>
    Reflect.get(window, 'autoFitStatusUI').geometry({}, 'mask'),
  );
  expect(reopened).toEqual(dims);
  const cpu = await page
    .locator('editor-image-canvas .canvas-wrap > canvas:not([data-gpu-live])')
    .evaluate((surface: HTMLCanvasElement, dims) => {
      const width = Math.min(surface.width, (surface.height * dims.w) / dims.h);
      const height = (width * dims.h) / dims.w;
      const probe = document.createElement('canvas');
      probe.width = probe.height = 64;
      const context = probe.getContext('2d')!;
      context.drawImage(
        surface,
        (surface.width - width) / 2,
        (surface.height - height) / 2,
        width,
        height,
        0,
        0,
        64,
        64,
      );
      return Array.from(context.getImageData(0, 0, 64, 64).data);
    }, dims);
  const difference =
    cpu.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : Math.abs(value - masked[i])), 0) /
    (64 * 64 * 3);
  console.log(
    JSON.stringify({
      backing,
      native: dims,
      maskCentroid: { x: x / weight, y: y / weight },
      cpuSpatialDifference: difference,
    }),
  );
  expect(difference).toBeLessThan(8); // Coarse spatial agreement, not a color-qualification budget.
  await page.evaluate(() => Reflect.get(window, 'autoFitStatusUI').dispose());
  expect(readFileSync(resolve('../../test-fixtures/raws', filename))).toEqual(bytes);
});

async function pixels(page: Page): Promise<number[]> {
  return page.locator('canvas[data-gpu-live]').evaluate((canvas: HTMLCanvasElement) => {
    const probe = document.createElement('canvas');
    probe.width = probe.height = 64;
    const context = probe.getContext('2d')!;
    context.drawImage(canvas, 0, 0, 64, 64);
    return Array.from(context.getImageData(0, 0, 64, 64).data);
  });
}
