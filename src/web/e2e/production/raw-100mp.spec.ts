import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import type { Worker } from '@playwright/test';
import { test, expect } from '../support/production-test';
import { installProductionFolderPicker } from '../support/production-folder-picker';
import {
  captureWorkerStatus,
  percentile,
  rawWorker,
  screenshotPixelEvidence,
  sessionOpenDuration,
  sessionRenderDurations,
  workerStatus,
} from '../support/raw-performance';

const FIXTURE = 'dji-mavic3pro-100mp.dng';

test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgpu',
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    ],
  },
});

test('Hosted canonical 100MP intake reaches the real editor and records open and slider evidence', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  test.setTimeout(420_000);
  const source = resolve(__dirname, '../../../../test-fixtures/raws', FIXTURE);
  const present = await access(source).then(
    () => true,
    () => false,
  );
  test.skip(!present, `${FIXTURE} is absent; no 100MP qualification was executed`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  const bytes = (await stat(source)).size;
  const folder = await mkdtemp(join(tmpdir(), 'maple-100mp-'));
  const report: Record<string, unknown> = {
    recordedAt: new Date().toISOString(),
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    fixture: FIXTURE,
    sha256,
    bytes,
    host: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      memoryBytes: totalmem(),
    },
    browser: page.context().browser()?.version(),
    outcome: 'not-started',
  };
  try {
    await copyFile(source, join(folder, FIXTURE));
    const picker = await installProductionFolderPicker(page, folder);
    await captureWorkerStatus(page);
    const workers: Worker[] = [];
    page.on('worker', (worker) => workers.push(worker));
    await page.goto('/');
    report['gpu'] = await page.evaluate(async () => {
      const gpu = (
        navigator as Navigator & {
          gpu?: {
            requestAdapter(): Promise<{
              info: {
                vendor: string;
                architecture: string;
                device: string;
                description: string;
                isFallbackAdapter: boolean;
              };
            } | null>;
          };
        }
      ).gpu;
      if (!gpu) return null;
      const adapter = await gpu.requestAdapter();
      return adapter
        ? {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
            isFallbackAdapter: adapter.info.isFallbackAdapter,
          }
        : null;
    });
    report['outcome'] = 'intake';
    // Independently prove the exact full payload crossed the bounded bridge.
    // This happens before open timing; no smaller substitute can satisfy its hash.
    const intake = await page.evaluate(async (filename) => {
      const picker = window as typeof window & {
        showDirectoryPicker(): Promise<{
          getFileHandle(name: string): Promise<{ getFile(): Promise<File> }>;
        }>;
      };
      const directory = await picker.showDirectoryPicker();
      const file = await (await directory.getFileHandle(filename)).getFile();
      const started = performance.now();
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return {
        bytes: bytes.byteLength,
        milliseconds: performance.now() - started,
        sha256: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      };
    }, FIXTURE);
    report['intake'] = intake;
    expect(intake.bytes).toBe(bytes);
    expect(intake.sha256).toBe(sha256);
    picker.clear();
    report['outcome'] = 'editor-open';
    const started = Date.now();
    await page.getByRole('button', { name: /open a folder/i }).click();
    await page.getByRole('button', { name: FIXTURE, exact: true }).click({ timeout: 120_000 });
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const exposure = page.getByRole('slider', { name: 'Exposure' });
    await expect(exposure).toBeVisible({ timeout: 120_000 });
    const worker = await rawWorker(page, workers);
    report['openMs'] = Date.now() - started;
    report['sessionOpenMs'] = await sessionOpenDuration(worker);
    report['worker'] = await workerStatus(page);
    const canvas = page.locator('canvas[data-gpu-live]');
    await expect(canvas).toBeVisible({ timeout: 120_000 });
    const pixels = await screenshotPixelEvidence(canvas);
    report['pixels'] = pixels;
    expect(pixels.range).toBeGreaterThan(20);
    expect(pixels.nonDarkFraction).toBeGreaterThan(0.05);
    report['outcome'] = 'slider-ticks';
    await exposure.focus();
    for (let tick = 0; tick < 20; tick++) {
      const count = (await sessionRenderDurations(worker)).length;
      await exposure.press('ArrowRight');
      await expect
        .poll(() => sessionRenderDurations(worker).then((values) => values.length))
        .toBe(count + 1);
    }
    const samples = (await sessionRenderDurations(worker)).slice(-16);
    const sorted = [...samples].sort((a, b) => a - b);
    const meanMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const p95Ms = percentile(sorted, 0.95);
    const maxMs = sorted.at(-1)!;
    report['slider'] = { samples, meanMs, p95Ms, maxMs };
    report['outcome'] = 'measured';
    // Existing slider thresholds remain unchanged for the canonical sensor.
    expect(samples).toHaveLength(16);
    expect(meanMs).toBeLessThanOrEqual(16);
    expect(p95Ms).toBeLessThanOrEqual(35);
    expect(maxMs).toBeLessThanOrEqual(50);
    report['outcome'] = 'passed';
  } catch (error) {
    report['error'] = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await testInfo.attach('canonical-100mp.json', {
      body: Buffer.from(JSON.stringify(report, null, 2)),
      contentType: 'application/json',
    });
    await rm(folder, { recursive: true, force: true });
  }
});
