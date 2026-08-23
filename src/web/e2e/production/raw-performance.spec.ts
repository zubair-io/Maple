import {
  chromium,
  type Browser,
  type Locator,
  type Page,
  type Worker as PlaywrightWorker,
} from '@playwright/test';
import { access, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { test, expect } from '../support/production-test';
import {
  readProductionFixtureManifest,
  resetWritableFixtureFolder,
} from '../support/production-fixtures';
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
// #2516: Chromium restored to threaded Rayon (8 workers). Historical
// exact-main threaded 22MP session-open evidence (PR#2517, before #2515
// forced Chromium serial): 5777.36 / 4856.75 / 4808.53 ms across 3 runs.
// This hard budget carries margin above that baseline for CI variance —
// ratchet down only with fresh browser evidence, same rule as before.
const THREADED_SESSION_OPEN_HARD_BUDGET_MS = 10_000;
const COLD_PREVIEW_P95_BUDGET_MS = 1_000;
const WARM_PREVIEW_MEDIAN_BUDGET_MS = 35;
// The first warm open on a fresh page pays one-time costs the warm path does
// not have in steady state — measured at 45-63 ms across ten runs against a
// 28-32 ms steady state, enough to push the 5-sample median over budget about
// one run in four (#2850). Discard it the same way the slider ticks below
// discard WARMUP_TICKS, so the budget measures the warm path rather than the
// page's first paint.
const WARMUP_OPENS = 1;
const MEASURED_OPENS = 5;

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
  // A cold open must measure a cold open: no `.maple` to hit, and no leftover
  // sidecar silently turning the cold budget into a develop of someone else's
  // adjustments (#2805).
  await resetWritableFixtureFolder(manifest.writableFolder);
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
  for (let iteration = 0; iteration < WARMUP_OPENS + MEASURED_OPENS; iteration += 1) {
    await openFolder(warmPage, WARM_DNG);
    warmPicker.clear();
    const warmPreview = await inPagePreviewPhases(
      warmPage.getByRole('button', { name: WARM_DNG, exact: true }),
    );
    if (iteration >= WARMUP_OPENS) {
      warmSamples.push(warmPreview.fastMs + warmPreview.refineMs);
    }
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
  expect(warmSamples).toHaveLength(MEASURED_OPENS);
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

test('Hosted restores threaded Chromium CPU work and renders live WebGPU slider ticks inside hard budgets', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  test.setTimeout(240_000);
  const manifest = await readProductionFixtureManifest();
  // Hard budgets need a fixed input: Exposure at its default, and an open that
  // decodes rather than painting whatever preview a previous test left in
  // `.maple` (#2805).
  await resetWritableFixtureFolder(manifest.writableFolder);
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
  // #2516: the #2515 growth race is closed by `prepare_threaded_heap`
  // (raw-wasm-init.ts) reserving heap BEFORE any Rayon worker isolate
  // exists, so Chromium threads again — same as every other safe runtime.
  await expect.poll(() => workerStatus(page)).toEqual({ threaded: true, threads: 8 });
  const status = await workerStatus(page);
  expect(rayonHelperRequests, 'Chromium must initialize the Rayon helper').not.toEqual([]);
  const worker = await rawWorker(page, observedWorkers);
  const fullDecodeMs = Date.now() - decodeStartedAt;
  const sessionOpenMs = await sessionOpenDuration(worker);
  expect(sessionOpenMs).toBeGreaterThan(0);
  expect(sessionOpenMs).toBeLessThanOrEqual(THREADED_SESSION_OPEN_HARD_BUDGET_MS);

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

/// A sensor over the wasm32 CPU develop budget (#2661): the 52.7 MP Canon 5DS R
/// frame (8896×5920). Its full-native-res develop peaks at 4.31 GB (native
/// probe, single-threaded) — over the 4 GiB wasm heap ceiling, the pre-fix OOM
/// trap — while the memory-clamped develop (`min(sensor/2, 4096)` = 4096) peaks
/// at 2.77 GB. The 100 MP reference fixture reproduces the same abort but its
/// 129 MB payload crashes the renderer inside the folder-picker shim's base64
/// CDP bridge, so the e2e uses the largest canonical fixture the bridge can
/// carry. Not part of `REQUIRED_RAW_FIXTURES` — the test skip-passes without
/// it, mirroring the fixture-gated Rust tests — and staged into its own temp
/// folder so the shared writable folder's staged-hash contract stays untouched.
const OVER_BUDGET_RAW = 'test_0003.CR2';

/** Sized-develop measure caps recorded by the render worker (`maple:wasm-sized:<cap>`). */
async function sizedDevelopCaps(worker: PlaywrightWorker): Promise<number[]> {
  return worker.evaluate(() =>
    performance
      .getEntriesByType('measure')
      .map((entry) => /^maple:wasm-sized:(\d+)$/.exec(entry.name)?.[1])
      .filter((cap): cap is string => cap !== undefined)
      .map(Number),
  );
}

test('Hosted no-WebGPU fallback opens an over-budget RAW and refines at 1:1 without exhausting the wasm heap', async ({
  page: _auditPage,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  const source = resolve(__dirname, '../../../../test-fixtures/raws', OVER_BUDGET_RAW);
  const largeFixturePresent = await access(source).then(
    () => true,
    () => false,
  );
  test.skip(!largeFixturePresent, `${OVER_BUDGET_RAW} not present (gitignored RAW fixture)`);
  // Serial-WASM decodes of a 50 MP CR2 measured ~70 s end-to-end on a warm M4;
  // leave generous headroom for loaded machines.
  test.setTimeout(420_000);

  // #2661 regression: the 1:1 refine below requests the native long edge
  // (8688). Pre-fix that developed FULL sensor resolution on the WASM-CPU
  // path — a 4.31 GB peak against the 4 GiB wasm32 heap (9.2 GB on the 100 MP
  // reference) — and aborted the worker with an unrecoverable
  // `RuntimeError: unreachable` OOM trap. The wasm entries now memory-clamp
  // the develop, so the refine must complete and repaint instead.
  const startedAt = Date.now();
  const errors: string[] = [];
  // Declared before the try, assigned inside it: a throw from any single
  // setup step (mkdtemp, launch, copyFile, newContext, newPage) must still
  // reach the `finally`, or a failed launch leaks the staged temp dir and a
  // failed newPage leaks a browser process into the rest of the CI run.
  let stagedFolder: string | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  try {
    stagedFolder = await mkdtemp(join(tmpdir(), 'maple-over-budget-e2e-'));
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    await copyFile(source, join(stagedFolder, OVER_BUDGET_RAW));
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL as string });
    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    page.on('requestfailed', (request) =>
      errors.push(`request: ${request.method()} ${request.url()} ${request.failure()?.errorText}`),
    );
    page.on('response', (response) => {
      if (response.status() >= 400) {
        errors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
      }
    });
    const observedWorkers: PlaywrightWorker[] = [];
    page.on('worker', (worker) => observedWorkers.push(worker));
    await forceNoWebGpu(page);
    await installProductionFolderPicker(page, stagedFolder);
    await page.goto('/');
    expect(
      await page.evaluate(() => 'gpu' in navigator),
      'the test must remove WebGPU support',
    ).toBe(false);

    const step = (name: string) =>
      // eslint-disable-next-line no-console
      console.info(`[over-budget-fallback] ${name} at t+${Date.now() - startedAt}ms`);
    await openEditor(page, OVER_BUDGET_RAW);
    step('editor open');
    await expect(page.getByText('Decoding RAW...')).toHaveCount(0, { timeout: 120_000 });
    step('decode settled');
    const fallbackCanvas = page.locator('.canvas-wrap > canvas:not([data-gpu-live])');
    await expect(fallbackCanvas).toBeVisible();
    const coldPixels = await screenshotPixelEvidence(fallbackCanvas);
    expect(coldPixels.range, 'the over-budget cold open must paint image detail').toBeGreaterThan(
      20,
    );
    step('cold pixels verified');

    // Find the render worker via its sized-develop perf measures (the cold
    // open's viewport-sized fast phase records the first one — no GPU session
    // measures exist on this path).
    let worker: PlaywrightWorker | undefined;
    // Captured non-null: `page` is declared outside the try so the `finally`
    // can always reach it, and TypeScript cannot narrow it through an async
    // closure boundary.
    const livePage = page;
    await expect
      .poll(
        async () => {
          const candidates = [...new Set([...observedWorkers, ...livePage.workers()])];
          for (const candidate of candidates) {
            const caps = await sizedDevelopCaps(candidate).catch(() => []);
            if (caps.length > 0) {
              worker = candidate;
              return true;
            }
          }
          return false;
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // 1:1 zoom (the `z` shortcut) raises the refine target to the native long
    // edge — the request that OOM-aborted the pre-fix worker. The recorded
    // measure completes only when the develop RETURNS, so its presence is the
    // no-trap evidence; the request cap stays the caller's (the memory clamp
    // is wasm-internal by design).
    step('render worker found');
    await page.keyboard.press('z');
    await expect
      .poll(async () => (await sizedDevelopCaps(worker!)).some((cap) => cap > 8000), {
        timeout: 180_000,
      })
      .toBe(true);

    step('native-target refine completed');
    const refinedPixels = await screenshotPixelEvidence(fallbackCanvas);
    expect(refinedPixels.range, 'the 1:1 refine must repaint image detail').toBeGreaterThan(20);
    expect(refinedPixels.nonDarkFraction, 'the refined canvas must not be blank').toBeGreaterThan(
      0.05,
    );
    expect(errors, 'the over-budget fallback session must not surface worker errors').toEqual([]);

    await context.close();
  } catch (failure) {
    // The default `page` fixture (the audit page) owns this run's automatic
    // screenshot/video, so a failure in THIS manually-launched context would
    // otherwise leave blank artifacts — attach the real page's state instead.
    // Every diagnostic is individually guarded so it can never mask `failure`.
    await testInfo
      .attach('over-budget-fallback-errors.json', {
        body: Buffer.from(JSON.stringify({ errors }, null, 2)),
        contentType: 'application/json',
      })
      .catch(() => undefined);
    const screenshot = page ? await page.screenshot({ type: 'png' }).catch(() => null) : null;
    if (screenshot) {
      await testInfo
        .attach('over-budget-fallback-page.png', { body: screenshot, contentType: 'image/png' })
        .catch(() => undefined);
    }
    throw failure;
  } finally {
    if (browser) await browser.close();
    if (stagedFolder) await rm(stagedFolder, { recursive: true, force: true });
  }
});

test('Hosted visibly falls back without WebGPU and still renders, edits, and restores XMP', async ({
  page: _auditPage,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  test.setTimeout(240_000);
  const manifest = await readProductionFixtureManifest();
  const sidecar = join(manifest.writableFolder, 'test_0006.xmp');
  // This test proves the CPU fallback genuinely decodes and edits, so clear
  // the preview cache that would otherwise let it paint a previous test's
  // artifact, along with the sidecar whose value it asserts against (#2805).
  await resetWritableFixtureFolder(manifest.writableFolder);

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
    // #2516: the no-WebGPU CPU fallback is exactly the path most exposed to
    // the #2515 growth race (it's the heaviest CPU user), so it's the most
    // important one to prove threads safely now.
    await expect.poll(() => workerStatus(page)).toEqual({ threaded: true, threads: 8 });
    const status = await workerStatus(page);
    expect(rayonHelperRequests, 'Chromium must initialize the Rayon helper').not.toEqual([]);

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
