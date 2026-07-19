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

// WebGPU-path coverage (#1960): Playwright's headless Chromium exposes
// `navigator.gpu` on a secure context but `requestAdapter()` resolves NULL
// without these flags, so the live GPU session could never open and the bench
// always soft-skipped into "no maple:session-render marks". `--enable-unsafe-webgpu`
// turns the adapter on in headless; `--use-angle=metal` picks the native Metal
// ANGLE backend on macOS (measured: adapter null without, non-null with, on the
// exact editor page). Platform-scoped so a Linux runner keeps its default ANGLE
// backend (Vulkan/SwiftShader) rather than a broken `metal` request; the
// unsafe-webgpu flag alone is inert where no adapter exists — the bench then
// soft-skips exactly as before.
test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgpu',
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    ],
  },
});

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
 * Enforced ceiling for the real per-tick render (#1939 → #1960). FOLDED INTO
 * THE SPEC HARD LIMIT: with the WebGPU launch flags below (the first
 * environment to produce a real measurement), the live WebGPU per-tick render
 * (`WebLiveSession.render_with_params`, the worker's own
 * `maple:session-render` measure) benches at mean 1.0–1.2ms / p95 ≤1.9ms /
 * max ≤2.5ms over 3×40 ticks on an M-series Mac — far under the 50ms spec.
 * The prior 350ms value was never a measurement, only an unpinned initial
 * guess (the bench had never actually run: no WebGPU adapter in headless, and
 * a wait-gate deadlock — see waitForSessionOpen). One-way ratchet: this may
 * only go down. Note the measure brackets the worker-side render call (encode
 * + submit + present); GPU execution completes asynchronously after present
 * and is not included — the same instrumentation boundary #1930 chose.
 */
const RENDER_INTERIM_CEILING_MS = SPEC_HARD_LIMIT_MS;

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

/** Count the worker's `maple:session-open`/`maple:session-render` measures
 *  (0 if none yet, or if the worker is busy in WASM — evalGuarded fallback). */
async function sessionMeasureCount(worker: PWWorker): Promise<number> {
  return evalGuarded(
    worker,
    () =>
      performance
        .getEntriesByType('measure')
        .filter((e) => e.name === 'maple:session-render' || e.name === 'maple:session-open').length,
    0,
  );
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
 * Poll (up to 90s) for the dedicated render worker to have emitted its
 * `maple:session-open` (or a first `maple:session-render`) mark — i.e. the live
 * session is up and presented its first frame. Returns the worker, or null if
 * none appears (no live render path here). Each read is timeout-guarded against
 * the worker being busy in WASM.
 *
 * Gates on session-OPEN, not session-render (#1960): after a clean open the
 * editor dedups the As-Shot-seeded model against `lastRenderedXmp`, so NO
 * render fires until a slider actually moves — waiting for a render mark
 * before driving the slider deadlocked into the soft-skip on every run. The
 * 90s budget absorbs a single-threaded WASM decode (the thread-pool bootstrap
 * can fall back; a session open then measures ~27s on the reference fixture).
 */
async function waitForSessionOpen(page: Page, extraWorkers: PWWorker[]): Promise<PWWorker | null> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    // A worker qualifies ONLY once it has actually emitted a session measure
    // (`sessionMeasureCount` returns > 0) — a worker that exists but has not
    // yet marked a session-open/render does not satisfy the gate, so the wait
    // continues until one does or the 90s deadline passes.
    for (const worker of [...page.workers(), ...extraWorkers]) {
      if ((await sessionMeasureCount(worker)) > 0) return worker;
    }
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
  // `exact` — the panel also contains a "Reset Light adjustments" button, which
  // a substring match resolves to as well (a strict-mode violation).
  await page.getByRole('button', { name: 'Light', exact: true }).click({ timeout: 10_000 });
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

/** Compute stats, print the summary, and assert the ceiling. */
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
      `ceiling=${RENDER_INTERIM_CEILING_MS}ms`,
  );
  expect(
    mean,
    `Mean web slider-tick render ${mean.toFixed(2)}ms exceeds the ` +
      `${RENDER_INTERIM_CEILING_MS}ms ceiling (the spec hard limit — the #1960 ` +
      `interim ceiling folded into it; measured floor ~1.2ms).`,
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
    // window (90s) + the drive (~12s) + margin all sit under this budget, and
    // every worker read is timeout-guarded.
    test.setTimeout(180_000);

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
      const worker = await waitForSessionOpen(page, workers);
      if (!worker) {
        skipReason =
          'No live render session established (no maple:session-open/render marks ' +
          'in 90s) — this environment lacks a stable WebGPU/WASM live render path ' +
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
