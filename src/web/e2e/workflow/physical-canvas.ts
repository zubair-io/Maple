import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Layout = { canvasW: number; canvasH: number };

export async function waitForGpuCanvas(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => (await Reflect.get(window, 'autoFitStatusUI').state()).gpuActive),
      { timeout: 120000 },
    )
    .toBe(true);
}

export async function openGpuCanvas(
  page: Page,
  filename: string,
): Promise<{ bytes: Buffer; folder: string }> {
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
  await waitForGpuCanvas(page);
  return { bytes, folder };
}

export async function downsample(
  page: Page,
  selector: string,
  layout: Layout | null = null,
): Promise<number[]> {
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
