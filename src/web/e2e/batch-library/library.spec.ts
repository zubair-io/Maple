import { expect, test, type CDPSession } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { BatchLibraryTest } from './main';

declare global {
  interface Window {
    batchLibrary: BatchLibraryTest;
  }
}

const execute = promisify(execFile);
const sampleIntervalMs = 100;
const reportPath = '/tmp/maple-3311-browser-measurement.json';

async function browserRss(cdp: CDPSession) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const processes = new Map<number, string>(
    processInfo.map((process: { id: number; type: string }) => [process.id, process.type]),
  );
  if (processes.size === 0) throw new Error('Chromium returned no processes for RSS measurement.');
  const { stdout } = await execute('ps', [
    '-o',
    'pid=,rss=',
    '-p',
    [...processes.keys()].join(','),
  ]);
  const readings = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, kib]) => processes.has(pid) && Number.isFinite(kib) && kib > 0)
    .map(([pid, kib]) => ({ pid, type: processes.get(pid)!, rssBytes: kib * 1024 }));
  if (readings.length === 0) throw new Error('Could not measure Chromium resident memory.');
  return {
    rssBytes: readings.reduce((total, process) => total + process.rssBytes, 0),
    processes: readings,
  };
}

async function sampleBrowser(cdp: CDPSession) {
  const baseline = await browserRss(cdp);
  let peak = baseline;
  let samples = 1;
  let stopped = false;
  let failure: unknown;
  const sampling = (async () => {
    while (!stopped) {
      await delay(sampleIntervalMs);
      if (stopped) break;
      try {
        const current = await browserRss(cdp);
        samples += 1;
        if (current.rssBytes > peak.rssBytes) peak = current;
      } catch (error) {
        failure = error;
        break;
      }
    }
  })();
  return async () => {
    stopped = true;
    await sampling;
    if (failure) throw failure;
    return {
      method:
        'Sum of RSS from ps for this Chromium instance PIDs supplied by browser CDP; shared pages may be counted more than once. Node and Vite excluded.',
      baseline,
      peak,
      extraPeakRssBytes: Math.max(0, peak.rssBytes - baseline.rssBytes),
      sampleIntervalMs,
      samples,
    };
  };
}

test('2,000 actual photograph sidecars fit the browser processing and memory budgets', async ({
  playwright,
  baseURL,
}, testInfo) => {
  // A normal persistent profile keeps OPFS on disk; an incognito context may hold it in RAM.
  const profile = await mkdtemp(join(tmpdir(), 'maple-batch-browser-'));
  try {
    const context = await playwright.chromium.launchPersistentContext(profile, {
      headless: true,
      baseURL,
    });
    try {
      const browser = context.browser();
      if (!browser) throw new Error('Chromium browser is unavailable for process RSS measurement.');
      const page = context.pages()[0] ?? (await context.newPage());
      page.on('console', (message) => {
        if (message.text().startsWith('BATCH_BROWSER_')) console.info(message.text());
      });
      page.on('pageerror', (error) => console.error('Browser host error:', error.message));
      await page.goto('/');
      await page.waitForFunction(() => window.batchLibrary?.ready === true, undefined, {
        timeout: 30_000,
      });
      const corpus = await page.evaluate(() => window.batchLibrary.setup());
      expect(corpus.imageCount).toBe(2000);
      expect(corpus.originalBytes).toBeGreaterThan(0);

      const cdp = await browser.newBrowserCDPSession();
      const stopSampling = await sampleBrowser(cdp);
      let memory: Awaited<ReturnType<typeof stopSampling>> | undefined;
      const result = await page
        .evaluate(() => window.batchLibrary.run())
        .finally(async () => {
          // Sampling ends before verification, which deliberately rereads every sidecar and original.
          memory = await stopSampling();
        });
      const report = {
        measuredAt: new Date().toISOString(),
        platform: process.platform,
        cpu: cpus()[0]?.model,
        browser: browser.version(),
        scope:
          'Chromium with an owned temporary persistent profile, native DOMParser, disk-backed OPFS copies of actual photos and XMP sidecars, IndexedDB ledger, actual Angular LibraryStateService and BatchSyncAssetIO, and production batch Worker. Setup and verification excluded from processing time and RSS sampling.',
        corpus,
        result,
        memory,
        budget: { processingSeconds: 120, extraPeakRssBytes: 512 * 1024 * 1024 },
        verified: false,
      };
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      await page.evaluate(() => window.batchLibrary.verify());
      report.verified = true;
      const json = JSON.stringify(report, null, 2) + '\n';
      await writeFile(reportPath, json);
      await testInfo.attach('browser-batch-measurement', {
        body: json,
        contentType: 'application/json',
      });
      console.info('BATCH_BROWSER_MEASUREMENT ' + json);
      await page.evaluate(() => window.batchLibrary.dispose());
      await cdp.detach();
      expect(result.applied).toBe(2000);
      expect(result.failed).toEqual([]);
      expect(result.seconds).toBeLessThanOrEqual(report.budget.processingSeconds);
      expect(memory!.extraPeakRssBytes).toBeLessThanOrEqual(report.budget.extraPeakRssBytes);
    } finally {
      await context.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
