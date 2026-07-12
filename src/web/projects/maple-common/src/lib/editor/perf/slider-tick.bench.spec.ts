// slider-tick.bench.spec.ts — automated slider-tick perf bench, web side (#641).
//
// Companion to src/apple/.../Performance/SliderTickPerfTests.swift. The Apple
// bench measures the live FFI-round-trip path that a slider drag triggers;
// the web bench has a smaller scope by necessity:
//
//   1. The web editor's real per-tick render uses WASM + WebGPU, which are not
//      available in the headless Vitest/jsdom runner. Anything that touches a
//      GPU/GL/WASM render context fails to run (no canvas), so we cannot
//      measure the render pass under `ng test`. The real render+present path is
//      now covered by the Playwright benchmark
//      `src/web/e2e/slider-tick-render.perf.spec.ts` (#1939), which drives an
//      actual RAW through the live editor and times the worker's
//      `maple:session-render` measures.
//
//   2. What THIS bench still covers — cheaply, on every `ng test` run — is the
//      EditorStateService.setArmedDisplayValue → LibraryStateService.updateAdjustment
//      → signal-update pipeline: the state plumbing every slider tick must
//      traverse before the render kicks off. If we regress here (e.g. by
//      introducing a synchronous diff-deep-clone on every patch), the GPU never
//      even gets a chance. The two are complementary — this is the fast
//      always-on state-pipe guard; the Playwright bench is the real render gate.
//
// File-naming note: this is `*.bench.spec.ts`, not `*.bench.ts`. The Angular
// builder (`@angular/build:unit-test`) globs `*.spec.ts` via Vitest's standard
// test runner; Vitest's `bench()` API needs `vitest bench`, which isn't wired
// up here. The `.bench.spec.ts` suffix makes the intent obvious to readers
// while keeping the file pickup-able by the existing test target.
//
// How to run:
//
//   cd src/web
//   MAPLE_PERF=1 npx ng test Maple-common --include='**/perf/*.bench.spec.ts'
//
// Note: the Angular project name is `Maple-common` (capital M) per
// `src/web/angular.json`. Lowercase `maple-common` fails case-sensitive
// lookups on Linux CI runners.
//
// Without `MAPLE_PERF=1` the suite skip-passes (mirrors the Apple gate).
//
// Spec: CLAUDE.md "Slider tick: 16ms target, 50ms hard limit"
//       docs/spec/05-performance.md § Target budgets (web row: <50ms / 100ms)

import { TestBed } from '@angular/core/testing';
import { signal, type Signal } from '@angular/core';

import { EditorStateService } from '../editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';

/**
 * Minimal LibraryStateService stand-in (copy of the harness in
 * `editor-state.service.spec.ts`) — holds a signal-backed
 * `AdjustmentModel` per asset id and applies `updateAdjustment` patches
 * as a shallow merge (`{ ...m, ...patch }`) into the signal value. Real
 * `LibraryStateService` writes also schedule a sidecar persist; the perf
 * bench wants only the synchronous state-plumbing cost, so the stub omits
 * the network/IDB side effects.
 */
class LibraryStub {
  private models = new Map<string, ReturnType<typeof signal<AdjustmentModel>>>();

  ensure(id: string): void {
    if (!this.models.has(id)) {
      this.models.set(id, signal(defaultAdjustmentModel()));
    }
  }

  adjustmentFor(id: string): Signal<AdjustmentModel> {
    this.ensure(id);
    return this.models.get(id)!.asReadonly();
  }

  updateAdjustment(id: string, patch: Partial<AdjustmentModel>): void {
    this.ensure(id);
    this.models.get(id)!.update((m) => ({ ...m, ...patch }));
  }
}

/**
 * Number of slider ticks per measurement run. Mirrors the Apple bench
 * (50 ticks ≈ a ~0.8 s drag at 60 Hz). Larger samples don't add signal
 * here — the state pipe is microsecond-scale.
 */
const TICK_COUNT = 50;

/** Spec hard limit for a single slider tick (CLAUDE.md + 05-performance.md). */
const SPEC_HARD_LIMIT_MS = 50;

/** Spec target — the CLAUDE.md product invariant. */
const SPEC_TARGET_MS = 16;

/**
 * Regression-detection ceiling for the state-pipe latency only. The
 * pipe is microsecond-scale on every JS engine in current use, so 5 ms
 * is loose enough to ride out CI scheduling jitter and tight enough
 * that a 100x regression (e.g. accidental deep clone on every patch)
 * trips it.
 *
 * The spec budget (16 / 50 ms) covers the full state + WASM + WebGL
 * tick — *not* just the state pipe. This bench can't measure the
 * full picture (no GL context in node). It can verify the state side
 * doesn't blow its share of the budget.
 */
const STATE_PIPE_REGRESSION_CEILING_MS = 5;

const ID = 'asset-perf-1';

describe('EditorStateService — slider-tick perf bench (#641)', () => {
  let svc: EditorStateService;
  let lib: LibraryStub;

  beforeEach(() => {
    lib = new LibraryStub();
    TestBed.configureTestingModule({
      providers: [{ provide: LibraryStateService, useValue: lib }],
    });
    svc = TestBed.inject(EditorStateService);
    svc.bind(ID);
    svc.armTool('exposure');
  });

  it('exposure-tick state pipe stays under regression ceiling', () => {
    // The Apple side gates on MAPLE_PERF=1 via ProcessInfo. The web
    // builder defaults to Vitest under Node + jsdom (per @angular/build
    // schema docs), so process.env IS reachable at runtime — but the
    // tsconfig has no 'node' types lib (browser-only), so we read the
    // value through `globalThis` to keep the cast away from the type
    // checker. Both surfaces use the same env var name so a single
    // `MAPLE_PERF=1` flips both.
    const procEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env;
    const env = procEnv ? procEnv['MAPLE_PERF'] : undefined;
    if (env !== '1') {
      // Vitest's `*.spec.ts` runner has no `XCTSkip` analog; the
      // explicit return + console.info is the closest equivalent and
      // keeps the suite green so day-to-day `ng test` runs don't print
      // a noisy `pending` for an opt-in perf bench.
      // eslint-disable-next-line no-console
      console.info(
        '[slider-tick-perf] skipped — set MAPLE_PERF=1 to run the slider-tick perf bench.',
      );
      return;
    }

    // Warm-up — first signal update can include lazy init cost.
    svc.setArmedDisplayValue(0.0);

    const samples: number[] = [];
    for (let i = 0; i < TICK_COUNT; i++) {
      // Sweep exposure across [-1, +1] EV per tick so the signal value
      // genuinely changes each iteration (no shortcut-on-identity).
      const t = i / (TICK_COUNT - 1);
      const exposure = -1.0 + 2.0 * t;

      const start = performance.now();
      svc.setArmedDisplayValue(exposure);
      const elapsed = performance.now() - start;
      samples.push(elapsed);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const mean = samples.reduce((acc, v) => acc + v, 0) / samples.length;
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const maxMs = sorted[sorted.length - 1];

    // Report — single-line stderr-friendly summary matching the Apple
    // bench's `[slider-tick-perf]` prefix so log greps work across both
    // halves.
    const summary =
      `[slider-tick-perf] scope=state-pipe ticks=${TICK_COUNT} ` +
      `mean=${mean.toFixed(3)}ms p50=${p50.toFixed(3)}ms ` +
      `p95=${p95.toFixed(3)}ms max=${maxMs.toFixed(3)}ms ` +
      `spec(target=${SPEC_TARGET_MS}ms hard=${SPEC_HARD_LIMIT_MS}ms) ` +
      `ceiling=${STATE_PIPE_REGRESSION_CEILING_MS}ms`;
    // eslint-disable-next-line no-console
    console.info(summary);

    expect(mean).toBeLessThan(STATE_PIPE_REGRESSION_CEILING_MS);

    if (mean > SPEC_TARGET_MS) {
      // eslint-disable-next-line no-console
      console.info(
        `[slider-tick-perf] WARN: state-pipe mean ${mean.toFixed(3)}ms exceeds ` +
          `spec target ${SPEC_TARGET_MS}ms — should never happen, the pipe ` +
          `is microsecond-scale; investigate.`,
      );
    }
  });
});
