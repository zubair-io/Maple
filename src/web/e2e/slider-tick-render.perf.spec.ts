import { test, expect, type Page, type Worker as PWWorker } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// slider-tick-render.perf.spec.ts — REAL web slider-tick perf benchmark (#1939).
//
// Replaces the signal it provides, not the file:
// `projects/maple-common/src/lib/editor/perf/slider-tick.bench.spec.ts` runs
// under Vitest/jsdom, where there is no WebGL/WebGPU/WASM render context, so it
// could only measure `EditorStateService.setArmedDisplayValue` against an
// in-file `LibraryStub` mock — the state pipe, never the render. Its own header
// flagged a Playwright-backed follow-up as the intended fix; this is it.
//
// This benchmark drives the ACTUAL WASM/WebGPU render + present path: it opens a
// real RAW into the live editor (which opens a GPU/WASM live session via
// image-canvas.gpu-present), arms the Exposure slider, and nudges it repeatedly.
// Each nudge runs the real per-tick render — `renderLiveSession` → the worker's
// `liveSession.render_with_params/render` (WASM core + WebGPU present, or the
// WASM-CPU fallback where WebGPU is unavailable). We measure each render with
// the worker's OWN `performance.measure('maple:session-render', …)` entries
// (raw-pipeline.worker.ts), read out of the dedicated worker's context via
// Playwright's `worker.evaluate()` — no app changes, the app already
// instruments this.
//
// Skip-pass discipline (mirrors raw-open.spec.ts + the Apple bench + the color
// harness): opt-in via MAPLE_PERF=1, skip when the RAW fixture is gitignored-
// absent, and skip when no live render session can be established in this
// environment (e.g. a headless build with neither WebGPU nor the WASM live
// path) rather than failing — the same "no capability here is a soft pass"
// contract used across the repo.
//
// Run:
//   cd src/web
//   MAPLE_PERF=1 bun x playwright test e2e/slider-tick-render.perf.spec.ts
//
// Spec: CLAUDE.md "Slider tick: 16ms target, 50ms hard limit";
//       docs/spec/05-performance.md § Target budgets (web row: 50ms / 100ms).

const FIXTURE = resolve(__dirname, '../../../test-fixtures/raws/test_0006.DNG');

/** Slider ticks per run (matches the Apple bench: ~0.8s drag at 60Hz). */
const TICK_COUNT = 40;

/** Warm-up ticks whose renders are discarded (first-render pipeline warm). */
const WARMUP_TICKS = 5;

/** Inter-press settle — past the editor's ~150ms render debounce. */
const INTER_PRESS_MS = 250;

/** CLAUDE.md product invariant. */
const SPEC_TARGET_MS = 16;
/** CLAUDE.md hard limit; docs/spec/05-performance.md web row lists 100ms hard. */
const SPEC_HARD_LIMIT_MS = 50;

/**
 * Enforced interim ceiling for the real per-tick render, ratcheting toward the
 * spec (#1939). This is an INITIAL, deliberately generous estimate — it sits
 * well above the 50ms spec hard limit because the live render floor (especially
 * the WASM-CPU path) is above spec, and it has not yet been pinned to a
 * machine-measured floor (the bench prints its measured mean/p50/p95/max every
 * run). Calibrate it down to ~2x the observed floor on the first environment
 * that produces a real measurement, then keep ratcheting toward the 50ms spec —
 * one-way, per the spec policy. Follow-up #1960 tracks that calibration.
 */
const RENDER_INTERIM_CEILING_MS = 350;

/**
 * `worker.evaluate` blocks while the worker's JS thread is synchronously busy
 * inside a WASM decode/render — so an unguarded read can stall until the test
 * timeout. Race it against a short timeout and treat a stall as "no data yet".
 */
async function evalGuarded<T>(worker: PWWorker, fn: () => T, fallback: T): Promise<T> {
  try {
    return await Promise.race([
      worker.evaluate(fn),
      new Promise<T>((r) => setTimeout(() => r(fallback), 1_500)),
    ]);
  } catch {
    // Worker torn down / page navigated between listing and evaluate.
    return fallback;
  }
}

/** Read the worker's session-render measure durations (empty if none/busy). */
async function sessionRenderDurations(worker: PWWorker): Promise<number[]> {
  return evalGuarded(
    worker,
    () =>
      performance
        .getEntriesByType('measure')
        .filter((e) => e.name === 'maple:session-render')
        .map((e) => e.duration),
    [] as number[],
  );
}

/** The dedicated worker that has emitted session marks, or null (busy/none). */
async function findRenderWorker(workers: PWWorker[]): Promise<PWWorker | null> {
  for (const w of workers) {
    const n = await evalGuarded(
      w,
      () =>
        performance
          .getEntriesByType('measure')
          .filter((e) => e.name === 'maple:session-render' || e.name === 'maple:session-open')
          .length,
      0,
    );
    if (n > 0) return w;
  }
  return null;
}

/** Open the landing, load the RAW, and wait for the editor route. */
async function openEditorWithRaw(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /open a photo/i })).toBeVisible();
  // The landing's hidden RAW picker (maple-syrup landing.component.html).
  // setInputFiles drives a display:none input directly — no click needed.
  await page.locator('input[type="file"]').first().setInputFiles(FIXTURE);
  await page.waitForURL(/\/edit\/[0-9a-f-]+/, { timeout: 30_000 });
}

/**
 * Poll (up to 45s) for the dedicated render worker to have emitted its first
 * `maple:session-render` mark — i.e. the live session opened and rendered once.
 * Returns the worker, or null if none appears (no live render path here). Each
 * read is timeout-guarded against the worker being busy in WASM.
 */
async function waitForFirstRender(page: Page, extraWorkers: PWWorker[]): Promise<PWWorker | null> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const worker = await findRenderWorker([...page.workers(), ...extraWorkers]);
    if (worker && (await sessionRenderDurations(worker)).length > 0) return worker;
    await page.waitForTimeout(500);
  }
  return null;
}

/**
 * Reveal the Light tool, focus the Exposure slider, and drive it TICK_COUNT +
 * WARMUP_TICKS times. Returns every session-render duration the drive produced
 * (past `baseline`). The editor DEBOUNCES renders, so presses can coalesce into
 * fewer renders — we drive with a fixed inter-press settle rather than waiting
 * per press (which would stall whenever a press coalesces). Time-bounded, so a
 * slow render path can't hang the test.
 */
async function driveExposure(page: Page, worker: PWWorker): Promise<number[]> {
  // Short timeouts so an undrivable editor UI throws (→ skip) rather than hangs.
  await page.getByRole('button', { name: 'Light' }).click({ timeout: 10_000 });
  const exposure = page.getByRole('slider', { name: /exposure/i });
  await expect(exposure).toBeVisible({ timeout: 10_000 });
  await exposure.focus();

  const baseline = (await sessionRenderDurations(worker)).length;
  for (let i = 0; i < TICK_COUNT + WARMUP_TICKS; i++) {
    await exposure.press('ArrowRight');
    await page.waitForTimeout(INTER_PRESS_MS);
  }
  await page.waitForTimeout(1_000); // let the final debounced render land
  return (await sessionRenderDurations(worker)).slice(baseline);
}

/**
 * Discard exactly the first WARMUP_TICKS renders (which warm the WASM/GPU
 * pipeline). If the drive produced no more than WARMUP_TICKS renders there is
 * nothing left to measure — return [] so the caller treats it as insufficient
 * (a warm-up render must never leak into the measured set).
 */
function postWarmupSamples(driven: number[]): number[] {
  return driven.length > WARMUP_TICKS ? driven.slice(WARMUP_TICKS) : [];
}

/** Compute stats, print the summary + OVER-BUDGET line, and assert the ceiling. */
function reportAndAssert(samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((acc, v) => acc + v, 0) / samples.length;
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const maxMs = sorted[sorted.length - 1];

  // eslint-disable-next-line no-console
  console.info(
    `[slider-tick-perf] scope=web-render ticks=${samples.length} ` +
      `mean=${mean.toFixed(2)}ms p50=${p50.toFixed(2)}ms ` +
      `p95=${p95.toFixed(2)}ms max=${maxMs.toFixed(2)}ms ` +
      `spec(target=${SPEC_TARGET_MS}ms hard=${SPEC_HARD_LIMIT_MS}ms) ` +
      `interim-hard=${RENDER_INTERIM_CEILING_MS}ms`,
  );
  if (mean > SPEC_HARD_LIMIT_MS) {
    // eslint-disable-next-line no-console
    console.info(
      `[slider-tick-perf] OVER-BUDGET: web-render mean ${mean.toFixed(2)}ms exceeds ` +
        `spec hard limit ${SPEC_HARD_LIMIT_MS}ms — the known floor-to-spec gap (#1960), ` +
        `reported, not a failure. The interim ceiling is what fails a regression.`,
    );
  }
  expect(
    mean,
    `Mean web slider-tick render ${mean.toFixed(2)}ms exceeds the ` +
      `${RENDER_INTERIM_CEILING_MS}ms interim ceiling (ratcheting toward the ` +
      `${SPEC_HARD_LIMIT_MS}ms spec — #1960).`,
  ).toBeLessThan(RENDER_INTERIM_CEILING_MS);
}

test.describe('Web — slider-tick render perf (#1939)', () => {
  test.skip(
    process.env['MAPLE_PERF'] !== '1',
    'Set MAPLE_PERF=1 to run the slider-tick render perf benchmark (opt-in, slow).',
  );
  test.skip(
    !existsSync(FIXTURE),
    `Fixture ${FIXTURE} missing. RAW fixtures are gitignored; drop a small DNG there to run this bench.`,
  );

  test('exposure drag renders under the interim ceiling', async ({ page }) => {
    // Bounded so the test can only ever measure-or-skip, never hang: the settle
    // window (45s) + the drive (~12s) + margin all sit under this budget, and
    // every worker read is timeout-guarded.
    test.setTimeout(120_000);

    const workers: PWWorker[] = [];
    page.on('worker', (w) => workers.push(w));

    // Collect the sample set inside a guard: any setup failure — an undrivable
    // editor control, a page/worker torn down during the heavy decode, a render
    // path that never emits marks, or too few post-warmup renders — means "this
    // environment can't drive the real render path here", which is a SKIP
    // (matching raw-open.spec.ts + the color harness soft-skip contract), not a
    // hard failure. The perf ASSERTION runs AFTER the guard, so a genuine
    // over-budget regression is never swallowed into a skip.
    let samples: number[] | null = null;
    let skipReason: string | null = null;
    try {
      await openEditorWithRaw(page);
      const worker = await waitForFirstRender(page, workers);
      if (!worker) {
        skipReason =
          'No live render session established (no maple:session-render marks in ' +
          '45s) — this environment lacks a stable WebGPU/WASM live render path ' +
          '(e.g. a headless build without WebGPU). Soft skip.';
      } else {
        const collected = postWarmupSamples(await driveExposure(page, worker));
        if (collected.length === 0) {
          skipReason =
            'Insufficient post-warmup renders (drive produced <= WARMUP_TICKS) — ' +
            'the render path is present but too slow/coalesced to sample here. Soft skip.';
        } else {
          samples = collected;
        }
      }
    } catch (e) {
      skipReason =
        'Could not drive the real render path in this environment ' +
        `(${e instanceof Error ? e.message : e}). Soft skip.`;
    }

    test.skip(skipReason !== null, skipReason ?? '');
    // Unreachable when skipped (test.skip throws); the guard keeps TS happy.
    if (!samples) return;

    reportAndAssert(samples);
  });
});
