import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const files = ['test_0007.DNG', 'test_0018.dng'];
for (const gpu of [false, true])
  test(`${gpu ? 'GPU live' : 'CPU'}: physical RAW Auto status follows actual render, profile, image and reopen`, async ({
    page,
  }) => {
    test.setTimeout(240000);
    test.skip(
      files.some((filename) => !existsSync(resolve('../../test-fixtures/raws', filename))),
      'Physical RAW fixtures are not installed',
    );
    for (const filename of files) {
      const bytes = readFileSync(resolve('../../test-fixtures/raws', filename));
      await page.route('**/physical-raw/' + filename, (route) =>
        route.fulfill({ body: bytes, contentType: 'application/octet-stream' }),
      );
    }
    await page.goto('http://localhost:4520');
    await page.waitForFunction(() => Reflect.get(window, 'autoFitStatusUI')?.ready);
    const name = await page.evaluate(
      ({ files, gpu }) => Reflect.get(window, 'autoFitStatusUI').mount(files, undefined, gpu),
      { files, gpu },
    );
    const status = page.getByTestId('profile-auto-status');
    await expect(status).toContainText('matched to this image’s embedded camera preview', {
      timeout: 120000,
    });
    expect(await page.evaluate(() => Reflect.get(window, 'autoFitStatusUI').state())).toEqual({
      profile: 'Auto',
      gpuActive: gpu,
      autoFit: true,
    });
    await page.getByRole('radio', { name: 'Neutral', exact: true }).click();
    await expect(status).toContainText('fixed base rendering');
    await page.evaluate(() => Reflect.get(window, 'autoFitStatusUI').state());
    await page.evaluate(
      ({ files, name, gpu }) => Reflect.get(window, 'autoFitStatusUI').mount(files, name, gpu),
      { files, name, gpu },
    );
    await expect(status).toContainText('fixed base rendering');
    await page.getByRole('radio', { name: 'Auto', exact: true }).click();
    await expect(status).toContainText('matched to this image’s embedded camera preview', {
      timeout: 120000,
    });
    await page.evaluate(
      (filename) => Reflect.get(window, 'autoFitStatusUI').focus(filename),
      files[1],
    );
    await expect(status).toHaveText('Auto matching is unavailable for this image.', {
      timeout: 120000,
    });
    expect(await page.evaluate(() => Reflect.get(window, 'autoFitStatusUI').state())).toEqual({
      profile: 'Auto',
      gpuActive: gpu,
      autoFit: false,
    });
    await page.evaluate(
      (filename) => Reflect.get(window, 'autoFitStatusUI').focus(filename),
      files[0],
    );
    await expect(status).toContainText('matched to this image’s embedded camera preview', {
      timeout: 120000,
    });
    await expect
      .poll(
        () =>
          page.evaluate((gpu) => {
            const surface = document.querySelector(
              gpu ? 'canvas[data-gpu-live]' : 'editor-image-canvas .canvas-wrap canvas',
            ) as HTMLCanvasElement | null;
            if (!surface || !surface.width || !surface.height) return false;
            const bounds = surface.closest('.canvas-wrap')?.getBoundingClientRect();
            if (!bounds || bounds.width < 1 || bounds.height < 1) return false;
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
    await page.evaluate(() => Reflect.get(window, 'autoFitStatusUI').dispose());
  });
