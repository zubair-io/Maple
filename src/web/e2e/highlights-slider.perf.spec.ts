import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonical100mpIdentity } from './support/canonical-100mp';
import { forceNoWebGpu, screenshotPixelEvidence, percentile } from './support/raw-performance';
import {
  installHighlightsMeter,
  highlightTicks,
  highlightsChronology,
  type HighlightTick,
} from './support/highlights-performance';

const SPEC_TARGET_MS = 16;
const SPEC_HARD_LIMIT_MS = 50;
const WARMUP_TICKS = 5;
const MEASURED_TICKS = 20;
const SETTLE_TIMEOUT_MS = 120_000;
const FIXTURE = resolve(__dirname, '../../../test-fixtures/raws/dji-mavic3pro-100mp.dng');

interface Route {
  readonly name: string;
  readonly report: string;
  readonly gpu: boolean;
  readonly workerRoute: string;
  readonly readyReply: string;
  readonly canvas: string;
}

const ROUTES: readonly Route[] = [
  {
    name: 'WebGPU',
    report: 'WebGPU present',
    gpu: true,
    workerRoute: 'render-session',
    readyReply: 'open-session-success',
    canvas: 'canvas[data-gpu-live]',
  },
  {
    name: 'CPU fallback',
    report: 'WASM CPU + real 2D draw',
    gpu: false,
    workerRoute: 'decode',
    readyReply: 'decode-success',
    canvas: 'editor-image-canvas .canvas-wrap > canvas:not([data-gpu-live])',
  },
];

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const canvasSha = async (canvas: Locator) => sha256(await canvas.screenshot({ type: 'png' }));

async function waitForWorkerReply(page: Page, type: string): Promise<void> {
  const replied = async () =>
    (await highlightsChronology(page)).some((row) => row['type'] === type);
  await expect.poll(replied, { timeout: SETTLE_TIMEOUT_MS }).toBe(true);
}

async function openEditor(page: Page, route: Route): Promise<{ slider: Locator; canvas: Locator }> {
  await page.setViewportSize({ width: 1920, height: 1280 });
  if (!route.gpu) await forceNoWebGpu(page);
  await installHighlightsMeter(page);
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles(FIXTURE);
  await page.waitForURL(/\/edit\//, { timeout: SETTLE_TIMEOUT_MS });
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  const slider = page.getByRole('slider', { name: 'Highlights', exact: true });
  await expect(slider).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
  const canvas = page.locator(route.canvas);
  await expect(canvas).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
  if (!route.gpu) await expect(page.getByText(/reduced-performance path/i)).toBeVisible();
  await waitForWorkerReply(page, route.readyReply);
  return { slider, canvas };
}

// Wait for the frame carrying this exact encoded value, so a late cold-open
// frame or a superseded request can never be timed as this input.
async function pressAndSettle(page: Page, slider: Locator, key: string): Promise<HighlightTick> {
  const priorInput = (await highlightTicks(page)).at(-1)?.inputAt ?? 0;
  const valueBefore = await slider.getAttribute('aria-valuenow');
  await slider.press(key);
  await expect(slider).not.toHaveAttribute('aria-valuenow', valueBefore ?? '');
  const valueAfter = Number(await slider.getAttribute('aria-valuenow'));
  expect(Number.isFinite(valueAfter)).toBe(true);
  const matches = (row: HighlightTick) =>
    row.inputAt > priorInput && row.encodedHighlights === valueAfter;
  await expect
    .poll(async () => (await highlightTicks(page)).some(matches), { timeout: SETTLE_TIMEOUT_MS })
    .toBe(true);
  return (await highlightTicks(page)).find(matches)!;
}

// Only move away from 0: a default-valued Highlights tick carries no encoded
// field to match, so the drive never crosses back through the default.
async function measureTicks(page: Page, slider: Locator, route: Route): Promise<HighlightTick[]> {
  await slider.focus();
  const rows: HighlightTick[] = [];
  for (let tick = 0; tick < WARMUP_TICKS + MEASURED_TICKS; tick++) {
    const row = await pressAndSettle(page, slider, 'ArrowRight');
    expect(row.route).toBe(route.workerRoute);
    expect(row.replyAt).toBeGreaterThanOrEqual(row.dispatchAt);
    expect(row.frameAt).toBeGreaterThanOrEqual(row.replyAt);
    rows.push(row);
  }
  return rows.slice(WARMUP_TICKS);
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

async function attachReport(page: Page, info: TestInfo, report: Record<string, unknown>) {
  const body = {
    ...report,
    browser: page.context().browser()?.version(),
    viewport: page.viewportSize(),
    chronology: await highlightsChronology(page),
    scope:
      'Serial settled slider inputs. renderSubmitMs is worker dispatch to reply; inputToFrameMs ' +
      'adds scheduling and the next main-thread frame after present or draw. Neither includes ' +
      'hardware scanout, and neither is continuous 60Hz input throughput.',
  };
  await info.attach('highlights-performance.json', {
    body: Buffer.from(JSON.stringify(body, null, 2)),
    contentType: 'application/json',
  });
}

for (const route of ROUTES) {
  test(`${route.name} Highlights reaches painted frames within existing budgets`, async ({
    page,
  }, info) => {
    test.skip(process.env['MAPLE_PERF'] !== '1', 'Existing performance opt-in is not enabled');
    test.setTimeout(600_000);
    const identity = await canonical100mpIdentity(FIXTURE);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { slider, canvas } = await openEditor(page, route);
    const initialCanvasSHA = await canvasSha(canvas);
    const initialPixels = await screenshotPixelEvidence(canvas);
    expect(initialPixels.range).toBeGreaterThan(20);
    const samples = await measureTicks(page, slider, route);
    expect(samples).toHaveLength(MEASURED_TICKS);
    const renderedCanvasSHA = await canvasSha(canvas);
    const renderedPixels = await screenshotPixelEvidence(canvas);
    expect(renderedCanvasSHA).not.toBe(initialCanvasSHA);
    expect(renderedPixels.range).toBeGreaterThan(20);
    expect(errors).toEqual([]);
    const inputToFrameMs = distribution(samples.map((row) => row.frameAt - row.inputAt));
    const renderSubmitMs = distribution(samples.map((row) => row.replyAt - row.dispatchAt));
    console.info(
      `[highlights-perf] route=${route.report} n=${samples.length} ` +
        `renderSubmitMs=${JSON.stringify(renderSubmitMs)} inputToFrameMs=${JSON.stringify(inputToFrameMs)}`,
    );
    await attachReport(page, info, {
      route: route.report,
      identity,
      samples,
      renderSubmitMs,
      inputToFrameMs,
      initialPixels,
      renderedPixels,
      initialCanvasSHA,
      renderedCanvasSHA,
    });
    expect(identity.sha256).toBe(sha256(await readFile(FIXTURE)));
    expect(inputToFrameMs.mean).toBeLessThanOrEqual(SPEC_TARGET_MS);
    expect(inputToFrameMs.max).toBeLessThanOrEqual(SPEC_HARD_LIMIT_MS);
  });
}
