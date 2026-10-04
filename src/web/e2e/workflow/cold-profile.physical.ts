import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const gpu of [false, true]) {
  test(`${gpu ? 'GPU live' : 'CPU'} applies Auto selected while reopening a real Neutral RAW`, async ({
    page,
  }) => {
    test.setTimeout(240000);
    const files = ['test_0007.DNG'];
    const bytes = readFileSync(resolve('../../test-fixtures/raws', files[0]));
    await page.route('**/physical-raw/' + files[0], (route) =>
      route.fulfill({ body: bytes, contentType: 'application/octet-stream' }),
    );
    await page.goto('http://localhost:4520');
    await page.waitForFunction(() => Reflect.get(window, 'coldProfileUI')?.ready);
    const name = await page.evaluate(
      ({ files, gpu }) => Reflect.get(window, 'coldProfileUI').mount(files, undefined, gpu),
      { files, gpu },
    );
    await page.getByTitle('Fit (⌘0)', { exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const state = await Reflect.get(window, 'coldProfileUI').state();
            return (
              !!state.rendered &&
              state.rendered === state.expected &&
              (state.gpuActive || state.bitmap)
            );
          }),
        { timeout: 120000 },
      )
      .toBe(true);
    await page.getByRole('radio', { name: 'Neutral', exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const state = await Reflect.get(window, 'coldProfileUI').state();
            return state.profile === 'Neutral' && state.rendered === state.expected;
          }),
        { timeout: 120000 },
      )
      .toBe(true);
    await page.evaluate(
      ({ files, name, gpu }) => Reflect.get(window, 'coldProfileUI').mount(files, name, gpu, true),
      { files, name, gpu },
    );
    await page.getByTitle('Fit (⌘0)', { exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate(async () => (await Reflect.get(window, 'coldProfileUI').state()).pending),
        { timeout: 120000 },
      )
      .toBe(true);
    await expect(page.getByRole('radio', { name: 'Neutral', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.getByRole('radio', { name: 'Auto', exact: true }).click();
    await page.evaluate(() => Reflect.get(window, 'coldProfileUI').release());
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const state = await Reflect.get(window, 'coldProfileUI').state();
            return state.completed && state.profile === 'Auto' && state.rendered === state.expected;
          }),
        { timeout: 120000 },
      )
      .toBe(true);
    const state = await page.evaluate(() => Reflect.get(window, 'coldProfileUI').state());
    expect(state.gpuActive).toBe(gpu);
    expect(state.dispatched).toContain('papp:Profile="Neutral"');
    expect(state.gateIntent).toContain('papp:Profile="Neutral"');
    expect(state.edits.some((xmp: string) => xmp.includes('papp:Profile="Auto"'))).toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate((gpu) => {
            const surface = document.querySelector(
              gpu ? 'canvas[data-gpu-live]' : 'editor-image-canvas .canvas-wrap canvas',
            ) as HTMLCanvasElement | null;
            if (!surface || !surface.width || !surface.height) return false;
            const wrap = surface.closest('.canvas-wrap')?.getBoundingClientRect();
            if (!wrap || wrap.width < 1 || wrap.height < 1) return false;
            const probe = document.createElement('canvas');
            probe.width = probe.height = 32;
            const context = probe.getContext('2d');
            if (!context) return false;
            context.drawImage(surface, 0, 0, 32, 32);
            const rgba = context.getImageData(0, 0, 32, 32).data;
            return Array.from(rgba).some((value, index) => index % 4 !== 3 && value > 16);
          }, gpu),
        { timeout: 10000 },
      )
      .toBe(true);
    await page.screenshot({ path: test.info().outputPath('auto-after-cold-open.png') });
    await page.evaluate(() => Reflect.get(window, 'coldProfileUI').dispose());
  });
}
