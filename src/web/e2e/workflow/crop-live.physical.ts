import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { downsample, openGpuCanvas, waitForGpuCanvas, type Layout } from './physical-canvas';

const filename = 'test_0013.DNG'; // Physical Rotate90 RAW, 4032 × 3024 sensor.
const rect = { left: 0.15, top: 0.1, right: 0.85, bottom: 0.7 };
const cases = [
  { name: 'rectangle', crop: { ...rect, angle: 0 } },
  { name: 'quarter turn', crop: { ...rect, angle: 90 } },
  { name: 'free angle', crop: { ...rect, angle: 5 } },
  {
    name: 'free angle over perspective',
    crop: { ...rect, angle: 5 },
    perspective: { perspectiveVertical: 20, perspectiveRotate: 2 },
  },
];

type Frame = { w: number; h: number };
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
  const { bytes, folder } = await openGpuCanvas(page, filename);
  const harness = ui(page);

  const uncropped = await backing(page);
  const tag = await harness.colorSpace();
  const report: object[] = [];
  for (const { name, crop, perspective } of cases) {
    await harness.geometry({ crop, ...perspective });
    const live = await backing(page);
    const gpu = await downsample(page, 'canvas[data-gpu-live]');
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
    const cpu = await downsample(
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
    await waitForGpuCanvas(page);
  }

  await harness.geometry({
    crop: { left: 0, top: 0, right: 1, bottom: 1, angle: 0 },
    perspectiveVertical: 0,
    perspectiveRotate: 0,
  });
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
