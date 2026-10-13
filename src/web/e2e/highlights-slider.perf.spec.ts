import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonical100mpIdentity } from './support/canonical-100mp';
import { forceNoWebGpu, screenshotPixelEvidence, percentile } from './support/raw-performance';
import {
  installHighlightsMeter,
  highlightTicks,
  highlightsChronology,
} from './support/highlights-performance';

// #4306: actual production Highlights input→worker→canvas/frame boundary.
// Keep render/submit and observable frame timings separate; neither is physical
// display scanout. No render capability/setup failure is converted into a pass.
for (const gpu of [true, false]) {
  test(`${gpu ? 'WebGPU' : 'CPU fallback'} Highlights reaches painted frames within existing budgets`, async ({
    page,
  }, info) => {
    test.skip(process.env['MAPLE_PERF'] !== '1', 'Existing performance opt-in is not enabled');
    test.setTimeout(600000);
    const source = resolve(__dirname, '../../../test-fixtures/raws/dji-mavic3pro-100mp.dng');
    const identity = await canonical100mpIdentity(source);
    const beforeHash = createHash('sha256')
      .update(await readFile(source))
      .digest('hex');
    await page.setViewportSize({ width: 1920, height: 1280 });
    if (!gpu) await forceNoWebGpu(page);
    await installHighlightsMeter(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.locator('input[type="file"]').first().setInputFiles(source);
    await page.waitForURL(/\/edit\//, { timeout: 120000 });
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    const slider = page.getByRole('slider', { name: 'Highlights', exact: true });
    await expect(slider).toBeVisible({ timeout: 120000 });
    const canvas = page.locator(
      gpu
        ? 'canvas[data-gpu-live]'
        : 'editor-image-canvas .canvas-wrap > canvas:not([data-gpu-live])',
    );
    await expect(canvas).toBeVisible({ timeout: 120000 });
    if (!gpu) await expect(page.getByText(/reduced-performance path/i)).toBeVisible();
    const initialCanvasSHA = createHash('sha256')
      .update(await canvas.screenshot({ type: 'png' }))
      .digest('hex');
    const initialPixels = await screenshotPixelEvidence(canvas);
    expect(initialPixels.range).toBeGreaterThan(20);
    await slider.focus();
    // MuiDragBar supports arrow nudges; Home is not a production input.
    // Match the encoded new value so a late cold-open frame cannot be timed.
    const initialValue = await slider.getAttribute('aria-valuenow');
    await slider.press('ArrowLeft');
    await expect(slider).not.toHaveAttribute('aria-valuenow', initialValue!);
    const firstChangedValue = Number(await slider.getAttribute('aria-valuenow'));
    await expect
      .poll(
        async () =>
          (await highlightTicks(page)).some((row) => row.encodedHighlights === firstChangedValue),
        { timeout: 120000 },
      )
      .toBe(true);
    const warmups = 5;
    const measured = 20;
    const samples = [];
    for (let tick = 0; tick < warmups + measured; tick++) {
      const prior = await highlightTicks(page);
      const priorInput = prior.at(-1)?.inputAt ?? 0;
      const valueBefore = await slider.getAttribute('aria-valuenow');
      await slider.press('ArrowRight');
      await expect(slider).not.toHaveAttribute('aria-valuenow', valueBefore!);
      const valueAfter = Number(await slider.getAttribute('aria-valuenow'));
      await expect
        .poll(
          async () =>
            (await highlightTicks(page)).some(
              (row) => row.inputAt > priorInput && row.encodedHighlights === valueAfter,
            ),
          {
            timeout: 120000,
          },
        )
        .toBe(true);
      const row = (await highlightTicks(page)).find(
        (row) => row.inputAt > priorInput && row.encodedHighlights === valueAfter,
      )!;
      expect(row.route).toBe(gpu ? 'render-session' : 'decode');
      expect(Number.isFinite(valueAfter)).toBe(true);
      expect(row.encodedHighlights).toBe(valueAfter);
      expect(row.frameAt).toBeGreaterThanOrEqual(row.replyAt);
      expect(row.replyAt).toBeGreaterThanOrEqual(row.dispatchAt);
      if (tick >= warmups) samples.push(row);
    }
    expect(samples).toHaveLength(measured);
    const renderedCanvasSHA = createHash('sha256')
      .update(await canvas.screenshot({ type: 'png' }))
      .digest('hex');
    expect(renderedCanvasSHA).not.toBe(initialCanvasSHA);
    const renderedPixels = await screenshotPixelEvidence(canvas);
    expect(renderedPixels.range).toBeGreaterThan(20);
    expect(errors).toEqual([]);
    const frameMs = samples.map((row) => row.frameAt - row.inputAt).sort((a, b) => a - b);
    const workerMs = samples.map((row) => row.replyAt - row.dispatchAt).sort((a, b) => a - b);
    const mean = frameMs.reduce((a, b) => a + b, 0) / measured;
    const report = {
      route: gpu ? 'WebGPU present' : 'WASM CPU + real 2D draw',
      identity,
      browser: page.context().browser()?.version(),
      viewport: page.viewportSize(),
      samples,
      chronology: await highlightsChronology(page),
      meanInputToFrameMs: mean,
      p95InputToFrameMs: percentile(frameMs, 0.95),
      maxInputToFrameMs: frameMs.at(-1),
      workerMs,
      initialPixels,
      renderedPixels,
      initialCanvasSHA,
      renderedCanvasSHA,
      scope:
        'Serial settled actual slider inputs. Includes scheduling/render/present acknowledgment and a browser frame boundary; excludes hardware scanout. Not continuous 60Hz input throughput.',
    };
    await info.attach('highlights-performance.json', {
      body: Buffer.from(JSON.stringify(report, null, 2)),
      contentType: 'application/json',
    });
    expect(
      createHash('sha256')
        .update(await readFile(source))
        .digest('hex'),
    ).toBe(beforeHash);
    // Existing product target/hard limit. Failures remain failures; no interim ceiling.
    expect(mean).toBeLessThanOrEqual(16);
    expect(frameMs.at(-1)!).toBeLessThanOrEqual(50);
  });
}
