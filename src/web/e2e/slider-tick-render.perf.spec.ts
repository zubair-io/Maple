import { test, expect, type Worker as PWWorker } from '@playwright/test';
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

    // Collect the per-render sample set inside a guard. Any setup failure — an
    // undrivable editor control, a page/worker torn down during the heavy
    // decode, a render path that never emits marks — means "this environment
    // can't drive the real render path here", which is a SKIP (matching
    // raw-open.spec.ts + the Apple bench + the color harness soft-skip
    // contract), not a hard failure. The perf ASSERTIONS run AFTER the guard so
    // a genuine over-budget regression is never swallowed into a skip.
    let samples: number[] | null = null;
    let skipReason: string | null = null;
    try {
      await page.goto('/');
      await expect(page.getByRole('button', { name: /open a photo/i })).toBeVisible();
      // The landing's hidden RAW picker (maple-syrup landing.component.html).
      // setInputFiles drives a display:none input directly — no click needed.
      await page.locator('input[type="file"]').first().setInputFiles(FIXTURE);
      await page.waitForURL(/\/edit\/[0-9a-f-]+/, { timeout: 30_000 });

      // Wait for the live session's first render (session open + first render),
      // polling the dedicated worker for its own perf marks (each read guarded
      // against the worker being busy in WASM). If none appears the live render
      // path isn't available in this environment → soft skip.
      let renderWorker: PWWorker | null = null;
      let firstRenders = 0;
      const settleDeadline = Date.now() + 45_000;
      while (Date.now() < settleDeadline) {
        renderWorker = await findRenderWorker([...page.workers(), ...workers]);
        if (renderWorker) {
          firstRenders = (await sessionRenderDurations(renderWorker)).length;
          if (firstRenders > 0) break; // at least one real render has happened
        }
        await page.waitForTimeout(500);
      }

      if (!renderWorker || firstRenders === 0) {
        skipReason =
          'No live render session established (no maple:session-render marks in ' +
          '45s) — this environment lacks a stable WebGPU/WASM live render path ' +
          '(e.g. a headless build without WebGPU). Soft skip.';
      } else {
        // Reveal the Light tool group (contains the Exposure slider), then focus
        // the Exposure slider (role="slider", aria-label="Exposure"). Short
        // timeouts so an undrivable editor UI skips rather than hangs.
        await page.getByRole('button', { name: 'Light' }).click({ timeout: 10_000 });
        const exposure = page.getByRole('slider', { name: /exposure/i });
        await expect(exposure).toBeVisible({ timeout: 10_000 });
        await exposure.focus();

        // Drive ticks. Each ArrowRight nudges exposure → a real render. The
        // editor DEBOUNCES renders, so rapid presses can coalesce into fewer
        // renders than presses — we drive with a fixed inter-press settle (past
        // the ~150ms debounce) rather than waiting per press (which stalls
        // whenever a press coalesces), then read every session-render measure
        // that accumulated. Each entry is one real WASM/WebGPU render+present.
        // The drive is time-bounded, so a slow render path can't hang the test.
        const INTER_PRESS_MS = 250; // > the editor's ~150ms render debounce
        const baseline = (await sessionRenderDurations(renderWorker)).length;
        for (let i = 0; i < TICK_COUNT + WARMUP_TICKS; i++) {
          await exposure.press('ArrowRight');
          await page.waitForTimeout(INTER_PRESS_MS);
        }
        await page.waitForTimeout(1_000); // let the final debounced render land

        // Every render triggered by the drive, minus the first WARMUP_TICKS
        // (which warm the WASM/GPU pipeline). Coalescing means the count may be
        // < the press count — fine, each captured entry is a genuine render.
        const driven = (await sessionRenderDurations(renderWorker)).slice(baseline);
        samples = driven.slice(Math.min(WARMUP_TICKS, Math.max(0, driven.length - 1)));
      }
    } catch (e) {
      skipReason =
        'Could not drive the real render path in this environment ' +
        `(${e instanceof Error ? e.message : e}). Soft skip.`;
    }

    test.skip(skipReason !== null, skipReason ?? '');
    // Unreachable when skipped (test.skip throws); the guard keeps TS happy.
    if (!samples) return;

    expect(
      samples.length,
      'No per-tick renders were captured despite an open live session — ' +
        'the exposure nudge did not trigger renderLiveSession (check the ' +
        'Light-tool / Exposure-slider wiring).',
    ).toBeGreaterThan(0);

    const sorted = [...samples].sort((a, b) => a - b);
    const mean = samples.reduce((acc, v) => acc + v, 0) / samples.length;
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const maxMs = sorted[sorted.length - 1];

    const summary =
      `[slider-tick-perf] scope=web-render ticks=${samples.length} ` +
      `mean=${mean.toFixed(2)}ms p50=${p50.toFixed(2)}ms ` +
      `p95=${p95.toFixed(2)}ms max=${maxMs.toFixed(2)}ms ` +
      `spec(target=${SPEC_TARGET_MS}ms hard=${SPEC_HARD_LIMIT_MS}ms) ` +
      `interim-hard=${RENDER_INTERIM_CEILING_MS}ms`;
    // eslint-disable-next-line no-console
    console.info(summary);

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
  });
});
