import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const filename = 'test_0013.DNG'; // Physical Rotate90 RAW, 4032 × 3024 sensor.
const rect = { left: 0.15, top: 0.1, right: 0.85, bottom: 0.7 };
const cases = [
  { name: 'rectangle', crop: { ...rect, angle: 0 } },
  { name: 'quarter turn', crop: { ...rect, angle: 90 } },
  { name: 'free angle', crop: { ...rect, angle: 5 } },
];

type Frame = { w: number; h: number };
type Layout = { canvasW: number; canvasH: number };
const ui = (page: Page) => ({
  mount: (gpu: boolean, folder?: string) =>
    page.evaluate(
      ({ filename, gpu, folder }) =>
        Reflect.get(window, 'autoFitStatusUI').mount([filename], folder, gpu),
      { filename, gpu, folder },
    ),
  geometry: (patch: object) =>
    page.evaluate(
      (patch) => Reflect.get(window, 'autoFitStatusUI').geometry(patch, 'exposure'),
      patch,
    ),
  dispose: () => page.evaluate(() => Reflect.get(window, 'autoFitStatusUI').dispose()),
  layout: () =>
    page.evaluate(() => Reflect.get(window, 'autoFitStatusUI').layout() as Layout | undefined),
  painted: () =>
    page.evaluate(() => Reflect.get(window, 'autoFitStatusUI').painted() as Frame | undefined),
  colorSpace: () =>
    page.evaluate(() => Reflect.get(window, 'autoFitStatusUI').colorSpace() as string),
});

test('live WebGPU canvas presents the cropped upright frame the CPU path paints', async ({
  page,
}) => {
  test.setTimeout(480000);
  const bytes = readFileSync(resolve('../../test-fixtures/raws', filename));
  await page.route('**/physical-raw/' + filename, (route) =>
    route.fulfill({ body: bytes, contentType: 'application/octet-stream' }),
  );
  await page.goto('http://localhost:4520');
  await page.waitForFunction(() => Reflect.get(window, 'autoFitStatusUI')?.ready);
  const harness = ui(page);
  const folder = await harness.mount(true);
  await expect
    .poll(
      () =>
        page.evaluate(async () => (await Reflect.get(window, 'autoFitStatusUI').state()).gpuActive),
      { timeout: 120000 },
    )
    .toBe(true);

  const uncropped = await backing(page);
  const tag = await harness.colorSpace();
  const report: object[] = [];
  for (const { name, crop } of cases) {
    await harness.geometry({ crop });
    const live = await backing(page);
    const gpu = await pixels(page, 'canvas[data-gpu-live]', null);
    const presented = await harness.painted();
    expect(presented, name).toEqual({ w: live.width, h: live.height });
    expect(live, name).not.toEqual(uncropped);
    expect(await harness.colorSpace(), `${name}: canvas colour space after resize`).toBe(tag);
    await harness.dispose();

    await harness.mount(false, folder);
    const aspect = async () => {
      const frame = await harness.painted();
      return frame ? frame.w / frame.h : 0;
    };
    await expect
      .poll(aspect, { message: `${name}: CPU aspect`, timeout: 120000 })
      .toBeCloseTo(live.width / live.height, 2);
    const cpuFrame = (await harness.painted())!;
    const cpu = await pixels(
      page,
      'editor-image-canvas .canvas-wrap > canvas:not([data-gpu-live])',
      (await harness.layout())!,
    );
    const difference =
      cpu.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : Math.abs(value - gpu[i])), 0) /
      (64 * 64 * 3);
    report.push({ name, gpu: live, cpu: cpuFrame, meanAbsDifference: difference });
    expect(difference, `${name}: coarse spatial agreement`).toBeLessThan(8);
    await harness.dispose();
    await harness.mount(true, folder);
    await expect
      .poll(
        () =>
          page.evaluate(
            async () => (await Reflect.get(window, 'autoFitStatusUI').state()).gpuActive,
          ),
        { timeout: 120000 },
      )
      .toBe(true);
  }

  await harness.geometry({ crop: { left: 0, top: 0, right: 1, bottom: 1, angle: 0 } });
  expect(await backing(page), 'clearing the crop restores the full frame').toEqual(uncropped);
  console.log(JSON.stringify({ uncropped, report }));
  await harness.dispose();
  expect(readFileSync(resolve('../../test-fixtures/raws', filename))).toEqual(bytes);
});

async function backing(page: Page) {
  return page
    .locator('canvas[data-gpu-live]')
    .evaluate((canvas: HTMLCanvasElement) => ({ width: canvas.width, height: canvas.height }));
}

async function pixels(page: Page, selector: string, layout: Layout | null): Promise<number[]> {
  return page.locator(selector).evaluate((surface: HTMLCanvasElement, layout) => {
    const scale = layout ? surface.width / surface.clientWidth : 1;
    const width = layout ? layout.canvasW * scale : surface.width;
    const height = layout ? layout.canvasH * scale : surface.height;
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
  }, layout);
}
