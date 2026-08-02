import {
  chromium,
  type Locator,
  type Page,
  type Worker as PlaywrightWorker,
} from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { test, expect } from '../support/production-test';
import { readProductionFixtureManifest } from '../support/production-fixtures';
import { installProductionFolderPicker } from '../support/production-folder-picker';
import {
  captureWorkerStatus,
  forceNoWebGpu,
  percentile,
  rawWorker,
  screenshotPixelEvidence,
  sessionOpenDuration,
  sessionRenderDurations,
  workerStatus,
} from '../support/raw-performance';

const DNG = 'test_0006.DNG';
const WARM_DNG = 'test_0017.dng';
const WARMUP_TICKS = 4;
const MEASURED_TICKS = 16;
const SLIDER_MEAN_BUDGET_MS = 16;
const SLIDER_P95_BUDGET_MS = 35;
const SLIDER_HARD_BUDGET_MS = 50;
// Temporary Chromium serial-mode ratchet for the real 22MP test_0006.DNG.
// #2516 restores safe Rayon and must lower this ceiling with browser evidence.
const SERIAL_SESSION_OPEN_HARD_BUDGET_MS = 30_000;
const COLD_PREVIEW_P95_BUDGET_MS = 1_000;
const WARM_PREVIEW_MEDIAN_BUDGET_MS = 35;

test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgpu',
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    ],
  },
});

async function openFolder(page: Page, filename: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /open a folder/i }).click();
  await expect(page).toHaveURL(/\/browse$/);
  await expect(page.getByRole('button', { name: filename, exact: true })).toBeVisible({
    timeout: 90_000,
  });
}

async function openEditor(page: Page, filename = DNG): Promise<void> {
  await openFolder(page, filename);
  await page.getByRole('button', { name: filename, exact: true }).click();
  await expect(page).toHaveURL(/\/view\//);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible({ timeout: 90_000 });
}

async function inPagePreviewPhases(button: Locator): Promise<{
  readonly fastMs: number;
  readonly refineMs: number;
}> {
  return button.evaluate(async (element) => {
    const started = performance.now();
    (element as HTMLButtonElement).click();
    const waitForImage = (selector: string, timeoutMs: number) =>
      new Promise<number>((resolve, reject) => {
        const deadline = performance.now() + timeoutMs;
        const inspect = () => {
          const image = document.querySelector<HTMLImageElement>(selector);
          if (image?.complete && image.naturalWidth > 0) {
            requestAnimationFrame(() => resolve(performance.now() - started));
            return;
          }
          if (performance.now() >= deadline) {
            reject(new Error(`${selector} pixels did not paint within ${timeoutMs}ms`));
            return;
          }
          requestAnimationFrame(inspect);
        };
        inspect();
      });
    const fastMs = await waitForImage('.preview-img', 10_000);
    const refinedAtMs = await waitForImage('.preview-img--full', 90_000);
    return { fastMs, refineMs: refinedAtMs - fastMs };
  });
}

test('Hosted cold embedded preview and warm .maple preview meet the open budgets', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  test.setTimeout(180_000);
  const manifest = await readProductionFixtureManifest();

  const coldPicker = await installProductionFolderPicker(page, manifest.writableFolder);
  await rm(join(manifest.writableFolder, '.maple'), { recursive: true, force: true });
  coldPicker.clear();
  await openFolder(page, DNG);
  const coldPreview = await inPagePreviewPhases(
    page.getByRole('button', { name: DNG, exact: true }),
  );
  expect(coldPreview.fastMs).toBeLessThanOrEqual(COLD_PREVIEW_P95_BUDGET_MS);
  expect(coldPreview.refineMs).toBeLessThanOrEqual(500);
  expect(
    coldPicker.operations.some(({ kind, path }) => kind === 'read' && path === DNG),
    'a cache miss must extract the embedded preview from the real RAW',
  ).toBe(true);

  const warmPage = await page.context().newPage();
  const warmPicker = await installProductionFolderPicker(warmPage, manifest.populatedFolder);
  const warmSamples: number[] = [];
  for (let iteration = 0; iteration < 5; iteration += 1) {
    await openFolder(warmPage, WARM_DNG);
    warmPicker.clear();
    const warmPreview = await inPagePreviewPhases(
      warmPage.getByRole('button', { name: WARM_DNG, exact: true }),
    );
    warmSamples.push(warmPreview.fastMs + warmPreview.refineMs);
    expect(
      warmPicker.operations.some(
        ({ kind, path }) => kind === 'read' && path === '.maple/previews/test_0017.dng.avif',
      ),
      'the warm preview must read the portable .maple artifact',
    ).toBe(true);
    expect(
      warmPicker.operations.some(({ kind, path }) => kind === 'read' && path === WARM_DNG),
      'a warm .maple preview must not read the RAW',
    ).toBe(false);
  }
  await warmPage.close();
  const sortedWarm = [...warmSamples].sort((a, b) => a - b);
  const warmMedianMs = percentile(sortedWarm, 0.5);
  expect(warmMedianMs).toBeLessThanOrEqual(WARM_PREVIEW_MEDIAN_BUDGET_MS);
  // eslint-disable-next-line no-console
  console.info(
    `[raw-open-performance] ${JSON.stringify({ coldPreview, warmSamples, warmMedianMs })}`,
  );

  await testInfo.attach('raw-open-performance.json', {
    body: Buffer.from(JSON.stringify({ coldPreview, warmSamples, warmMedianMs }, null, 2)),
    contentType: 'application/json',
  });
});

test('Hosted keeps Chromium CPU work serial and renders live WebGPU slider ticks inside hard budgets', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  test.setTimeout(240_000);
  const manifest = await readProductionFixtureManifest();
  await rm(join(manifest.writableFolder, 'test_0006.xmp'), { force: true });
  await installProductionFolderPicker(page, manifest.writableFolder);
  await captureWorkerStatus(page);
  const observedWorkers: PlaywrightWorker[] = [];
  page.on('worker', (worker) => observedWorkers.push(worker));
  const rayonHelperRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/workerHelpers.js')) {
      rayonHelperRequests.push(request.url());
    }
  });

  const decodeStartedAt = Date.now();
  await openEditor(page);
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => navigator.userAgent)).toContain('Chrome/');
  const editorUiMs = Date.now() - decodeStartedAt;
  await expect.poll(() => workerStatus(page)).toEqual({ threaded: false, threads: 1 });
  const status = await workerStatus(page);
  expect(rayonHelperRequests, 'Chromium must not initialize a Rayon helper').toEqual([]);
  const worker = await rawWorker(page, observedWorkers);
  const fullDecodeMs = Date.now() - decodeStartedAt;
  const sessionOpenMs = await sessionOpenDuration(worker);
  expect(sessionOpenMs).toBeGreaterThan(0);
  expect(sessionOpenMs).toBeLessThanOrEqual(SERIAL_SESSION_OPEN_HARD_BUDGET_MS);

  const canvas = page.locator('canvas[data-gpu-live]');
  await expect(canvas).toBeVisible({ timeout: 90_000 });
  const pixels = await screenshotPixelEvidence(canvas);
  expect(pixels.width).toBeGreaterThan(100);
  expect(pixels.height).toBeGreaterThan(100);
  expect(pixels.range, 'the WebGPU canvas must contain visible image detail').toBeGreaterThan(20);
  expect(
    pixels.nonDarkFraction,
    'the WebGPU canvas must not be a blank/black present',
  ).toBeGreaterThan(0.05);
  await expect(page.getByText(/reduced-performance path/i)).toHaveCount(0);

  const exposure = page.getByRole('slider', { name: 'Exposure' });
  await exposure.focus();
  let expectedCount = (await sessionRenderDurations(worker)).length;
  for (let tick = 0; tick < WARMUP_TICKS + MEASURED_TICKS; tick += 1) {
    await exposure.press('ArrowRight');
    expectedCount += 1;
    await expect
      .poll(() => sessionRenderDurations(worker).then((values) => values.length))
      .toBe(expectedCount);
  }
  const allSamples = await sessionRenderDurations(worker);
  const samples = allSamples.slice(-MEASURED_TICKS);
  expect(samples).toHaveLength(MEASURED_TICKS);
  const sorted = [...samples].sort((a, b) => a - b);
  const meanMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const p95Ms = percentile(sorted, 0.95);
  const maxMs = sorted.at(-1)!;
  expect(meanMs).toBeLessThanOrEqual(SLIDER_MEAN_BUDGET_MS);
  expect(p95Ms).toBeLessThanOrEqual(SLIDER_P95_BUDGET_MS);
  expect(maxMs).toBeLessThanOrEqual(SLIDER_HARD_BUDGET_MS);
  // eslint-disable-next-line no-console
  console.info(
    `[raw-gpu-performance] ${JSON.stringify({ status, editorUiMs, fullDecodeMs, sessionOpenMs, pixels, meanMs, p95Ms, maxMs })}`,
  );

  await testInfo.attach('raw-gpu-performance.json', {
    body: Buffer.from(
      JSON.stringify(
        { status, editorUiMs, fullDecodeMs, sessionOpenMs, pixels, samples, meanMs, p95Ms, maxMs },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });
});

test('Hosted visibly falls back without WebGPU and still renders, edits, and restores XMP', async ({
  page: _auditPage,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  test.setTimeout(240_000);
  const manifest = await readProductionFixtureManifest();
  const sidecar = join(manifest.writableFolder, 'test_0006.xmp');
  await rm(sidecar, { force: true });

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
  });
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL as string });
  const page = await context.newPage();
  const errors: string[] = [];
  const rayonHelperRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('requestfailed', (request) =>
    errors.push(`request: ${request.method()} ${request.url()} ${request.failure()?.errorText}`),
  );
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/workerHelpers.js')) {
      rayonHelperRequests.push(request.url());
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  try {
    await forceNoWebGpu(page);
    await captureWorkerStatus(page);
    await installProductionFolderPicker(page, manifest.writableFolder);
    await page.goto('/');
    expect(await page.evaluate(() => isSecureContext)).toBe(true);
    expect(
      await page.evaluate(() => 'gpu' in navigator),
      'the test must remove WebGPU support',
    ).toBe(false);

    await openEditor(page);
    await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(() => navigator.userAgent)).toContain('Chrome/');
    await expect(page.getByText(/reduced-performance path/i)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible({ timeout: 90_000 });
    await expect.poll(() => workerStatus(page)).toEqual({ threaded: false, threads: 1 });
    const status = await workerStatus(page);
    expect(rayonHelperRequests, 'Chromium must not initialize a Rayon helper').toEqual([]);

    const fallbackCanvas = page.locator('.canvas-wrap > canvas:not([data-gpu-live])');
    await expect(fallbackCanvas).toBeVisible();
    await expect(page.getByText('Decoding RAW...')).toHaveCount(0, { timeout: 90_000 });
    const pixels = await screenshotPixelEvidence(fallbackCanvas);
    expect(
      pixels.range,
      'the CPU fallback canvas must contain visible image detail',
    ).toBeGreaterThan(20);
    expect(pixels.nonDarkFraction, 'the CPU fallback canvas must not be blank').toBeGreaterThan(
      0.05,
    );

    const exposure = page.getByRole('slider', { name: 'Exposure' });
    await exposure.focus();
    await exposure.press('ArrowRight');
    await expect(exposure).not.toHaveAttribute('aria-valuenow', '0');
    const editedExposure = await exposure.getAttribute('aria-valuenow');
    await expect
      .poll(() => readFile(sidecar, 'utf8').catch(() => ''))
      .toContain(`crs:Exposure2012="${editedExposure}"`);

    await page.reload();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('button', { name: /open a folder/i }).click();
    await page.getByRole('button', { name: DNG, exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('slider', { name: 'Exposure' })).toHaveAttribute(
      'aria-valuenow',
      editedExposure!,
      { timeout: 90_000 },
    );
    expect(errors).toEqual([]);
    // eslint-disable-next-line no-console
    console.info(`[raw-cpu-fallback] ${JSON.stringify({ status, pixels })}`);

    await testInfo.attach('raw-cpu-fallback.json', {
      body: Buffer.from(JSON.stringify({ status, pixels }, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    await context.close();
    await browser.close();
  }
});
