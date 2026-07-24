// raw-pipeline.perf.spec.ts
//
// #1123: `safeMeasure` isolates Performance Timeline bookkeeping so a throw from
// `performance.measure` (thrown when a named mark was cleared out from under it —
// DevTools' `performance.clearMarks()`, a monitoring shim, or a test harness) can
// never propagate out of the diagnostics and strand the caller's real work.
//
// This is a PURE spec — no Angular TestBed, no raw-wasm import — so it runs under
// plain `bunx vitest run` without needing the wasm artefact synced. It is the
// executable proof for the fix; `raw-pipeline.service.spec.ts` and
// `raw-pipeline.worker.ts` additionally document + apply the same helper at every
// mark/measure call site (verified by inspection — see PR description), but that
// spec file needs `ng test` (Angular TestBed + a built raw-wasm pkg) to run.

import { describe, it, expect, vi } from 'vitest';

import { safeMeasure } from './raw-pipeline.perf';

describe('safeMeasure (#1123)', () => {
  it('runs the callback and does not throw when the callback succeeds', () => {
    const fn = vi.fn();
    expect(() => safeMeasure(fn)).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('swallows a throw from the callback instead of propagating it', () => {
    const fn = vi.fn(() => {
      throw new DOMException(
        "Failed to execute 'measure' on 'Performance': The mark 'maple:decode:1:start' does not exist.",
        'SyntaxError',
      );
    });
    expect(() => safeMeasure(fn)).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('logs a warning (not an error) on a swallowed throw, so it never surfaces as a failure', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    safeMeasure(() => {
      throw new Error('simulated Performance Timeline throw');
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('performance measurement failed');
    warnSpy.mockRestore();
  });

  it('demonstrates the exact failure mode: mark → clearMarks → measure throws, guarded by safeMeasure', () => {
    // Mirrors what DevTools' `performance.clearMarks()` (or a monitoring shim, or a
    // test harness) can do between a decode's start and end mark — the real trigger
    // for #1123. Without the wrapper, `performance.measure` below throws a
    // `SyntaxError` because the start mark no longer exists.
    performance.mark('maple:decode:1123:start');
    performance.clearMarks('maple:decode:1123:start');

    expect(() => {
      performance.measure('maple:decode', 'maple:decode:1123:start', 'maple:decode:1123:end');
    }).toThrow();

    // The guarded call must NOT throw — this is the behaviour every call site in
    // raw-pipeline.service.ts and raw-pipeline.worker.ts now relies on so a
    // Performance Timeline hiccup can never strand a pending decode's `resolve`
    // (main thread, serialized behind `decodeChain`) or mislabel a successful
    // worker result as an error.
    expect(() => {
      safeMeasure(() => {
        performance.mark('maple:decode:1123:end');
        performance.measure('maple:decode', 'maple:decode:1123:start', 'maple:decode:1123:end');
      });
    }).not.toThrow();
  });
});
