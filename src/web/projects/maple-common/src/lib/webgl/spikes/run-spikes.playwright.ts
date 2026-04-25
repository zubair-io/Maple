/**
 * Plan 3 M2.1 verification spikes — Playwright cross-browser runner.
 *
 * Runs the throwaway probe at `./probe.html` in headed Chromium / Firefox /
 * WebKit, captures the `__SPIKE_RESULTS__` JSON object, prints a
 * tabular summary to stdout, and writes `./results-<browser>.json` for
 * the human reviewer.
 *
 * The spec uses the `.playwright.ts` suffix (not `.spec.ts`) so the Angular
 * vitest runner doesn't try to load it as a unit test — Playwright tests
 * import `@playwright/test`, which the vitest harness can't satisfy.
 *
 * Runnable on demand via:
 *
 *     cd src/web && npx playwright test \
 *       projects/maple-common/src/lib/webgl/spikes/run-spikes.playwright.ts \
 *       --config=projects/maple-common/src/lib/webgl/spikes/playwright.config.ts
 *
 * The dedicated playwright config alongside this spec drives all three
 * browsers (chromium, firefox, webkit) without spinning up the Angular dev
 * server — the probe is a static HTML file loaded via `file://`.
 */

import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROBE_URL = 'file://' + resolve(__dirname, 'probe.html');
const OUTPUT_DIR = __dirname;

interface SpikeResults {
  ua: string;
  spike11: {
    verdict: string;
    detail: string;
    sampled?: string[];
    sampledFloats?: number[];
    expected?: string[];
  };
  spike12: {
    verdict: string;
    detail: string;
    t0_apple?: number;
    t1_apple?: number;
    t1_sym?: number;
    thalf_apple?: number;
    expected?: { t0: number; t1_apple: number; t1_sym: number; t_half: number };
    note?: string;
  };
  spike13: {
    verdict: string;
    detail: string;
    implFormat?: string;
    implType?: string;
    nativeOk?: boolean;
    nativeMsg?: string;
    lanesNative?: string[] | null;
    floatOk?: boolean;
    floatMsg?: string;
    lanesFloat?: number[] | null;
  };
}

async function runSpikes(page: Page): Promise<SpikeResults> {
  const consoleLines: string[] = [];
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));

  await page.goto(PROBE_URL);
  await page.waitForFunction(
    () => (window as unknown as { __SPIKE_DONE__: boolean }).__SPIKE_DONE__,
    undefined,
    {
      timeout: 30_000,
    },
  );

  const results = (await page.evaluate(
    () => (window as unknown as { __SPIKE_RESULTS__: SpikeResults }).__SPIKE_RESULTS__,
  )) as SpikeResults;

  if (consoleLines.length) {
    console.log('  console:');
    for (const line of consoleLines) console.log('    ' + line);
  }
  return results;
}

function summarize(browserName: string, r: SpikeResults): void {
  console.log('\n=========================================');
  console.log(`Browser: ${browserName}`);
  console.log(`UA: ${r.ua}`);
  console.log('=========================================');
  console.log(`Spike 1.1 (fp16 sampling parity):  ${r.spike11.verdict}`);
  console.log(`  ${r.spike11.detail}`);
  if (r.spike11.sampled) {
    console.log(`  sampled: ${r.spike11.sampled.join(' ')}`);
    console.log(`  expected: ${r.spike11.expected?.join(' ')}`);
  }
  console.log(`Spike 1.2 (AgX LUT edge sampling): ${r.spike12.verdict}`);
  console.log(`  ${r.spike12.detail}`);
  if (r.spike12.t1_apple !== undefined) {
    console.log(`  t=0   formula (a): ${r.spike12.t0_apple?.toFixed(4)}`);
    console.log(`  t=1   formula (a): ${r.spike12.t1_apple?.toFixed(4)} (expect 0.875)`);
    console.log(`  t=1   formula (b): ${r.spike12.t1_sym?.toFixed(4)} (expect 1.0000)`);
    console.log(`  t=0.5 formula (a): ${r.spike12.thalf_apple?.toFixed(4)} (expect 0.25)`);
  }
  console.log(`Spike 1.3 (fp16 readback):          ${r.spike13.verdict}`);
  console.log(`  ${r.spike13.detail}`);
  if (r.spike13.lanesNative) {
    console.log(`  native lanes: ${r.spike13.lanesNative.join(' ')}`);
  }
  if (r.spike13.lanesFloat) {
    console.log(`  float lanes:  ${r.spike13.lanesFloat.map((v) => v.toFixed(4)).join(' ')}`);
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('Plan 3 M2.1 verification spikes', () => {
  test('spikes — chromium / firefox / webkit', async ({ page, browserName }) => {
    const results = await runSpikes(page);
    summarize(browserName, results);

    const outFile = resolve(OUTPUT_DIR, `results-${browserName}.json`);
    writeFileSync(outFile, JSON.stringify(results, null, 2));
    console.log(`  wrote ${outFile}`);

    // Assertion budget:
    //   Spike 1.1: PASS or PASS-LSB (1 LSB drift acceptable).
    //   Spike 1.2: PASS (deterministic bilinear math).
    //   Spike 1.3: PASS or PASS-FLOAT-FALLBACK.
    //
    // Firefox in headless Playwright builds does not expose
    // EXT_color_buffer_half_float (it relies on a hardware GPU init path
    // disabled in headless). The brief's target browsers are Chromium
    // (Blink) + WebKit (Safari); Firefox is informational only. We log
    // its result and mark it `informational` rather than fail the suite.
    if (browserName === 'firefox') {
      // eslint-disable-next-line no-console
      console.log(
        '  (firefox is informational only — headless Firefox lacks GPU-backed ' +
          'EXT_color_buffer_half_float; M2.1 targets Chromium + WebKit per brief).',
      );
      return;
    }
    expect(['PASS', 'PASS-LSB']).toContain(results.spike11.verdict);
    expect(results.spike12.verdict).toBe('PASS');
    expect(['PASS', 'PASS-FLOAT-FALLBACK']).toContain(results.spike13.verdict);
  });
});
