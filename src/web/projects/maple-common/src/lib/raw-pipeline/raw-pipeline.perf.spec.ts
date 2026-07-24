// raw-pipeline.perf.spec.ts
//
// #1123: `safeMeasure` isolates Performance Timeline bookkeeping so a throw from
// `performance.measure` (thrown when a named mark was cleared out from under it —
// DevTools' `performance.clearMarks()`, a monitoring shim, or a test harness) can
// never propagate out of the diagnostics and strand the caller's real work.
// `markScopeReadback` additionally proves the jules-review BLOCKING fix: every
// Performance Timeline call it makes — including its own cleanup — is independently
// guarded, so a `measure` throw can't skip a `clearMarks`/`clearMeasures` call that
// comes after it.
//
// This is a PURE spec — no Angular TestBed, no raw-wasm import — so it runs under
// plain `bunx vitest run` without needing the wasm artefact synced. It is the
// executable proof for the fix; `raw-pipeline.service.spec.ts` and
// `raw-pipeline.worker.ts` additionally document + apply the same helpers at every
// mark/measure call site, but that spec file needs `ng test` (Angular TestBed + a
// built raw-wasm pkg) to run.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  safeMeasure,
  markStart,
  markEnd,
  markScopeReadback,
  resetSafeMeasureWarnThrottleForTests,
} from './raw-pipeline.perf';

describe('safeMeasure (#1123)', () => {
  beforeEach(() => {
    resetSafeMeasureWarnThrottleForTests();
  });

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

  it('throttles repeated warnings to at most one per second (jules review, #1123)', () => {
    // A persistent mark-clearer could otherwise make every decode/render tick log —
    // several times a second on a slider drag — and synchronous console output on
    // that hot path works against the 16ms slider-tick budget.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwing = () => {
      throw new Error('simulated Performance Timeline throw');
    };
    safeMeasure(throwing);
    safeMeasure(throwing);
    safeMeasure(throwing);
    expect(warnSpy).toHaveBeenCalledTimes(1);
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

describe('markStart / markEnd (#1123)', () => {
  it('places a start mark and, on markEnd, an end mark plus a named measure', () => {
    markStart('maple:test-span:1:start');
    markEnd('maple:test-span:1:start', 'maple:test-span:1:end', 'maple:test-span');

    const measures = performance.getEntriesByName('maple:test-span', 'measure');
    expect(measures.length).toBeGreaterThan(0);

    performance.clearMarks('maple:test-span:1:start');
    performance.clearMarks('maple:test-span:1:end');
    performance.clearMeasures('maple:test-span');
  });

  it('markEnd never throws even when the start mark was cleared out from under it', () => {
    markStart('maple:test-span:2:start');
    performance.clearMarks('maple:test-span:2:start');
    expect(() =>
      markEnd('maple:test-span:2:start', 'maple:test-span:2:end', 'maple:test-span-2'),
    ).not.toThrow();
    performance.clearMarks('maple:test-span:2:end');
  });
});

describe('markScopeReadback (jules review, #1123)', () => {
  it('returns the wrapped callback result', () => {
    const result = markScopeReadback(1, () => 'scope-snapshot');
    expect(result).toBe('scope-snapshot');
  });

  it('clears its own marks/measure after a successful measure', () => {
    markScopeReadback(2, () => undefined);
    expect(performance.getEntriesByName('maple:scope-readback:2:start', 'mark')).toHaveLength(0);
    expect(performance.getEntriesByName('maple:scope-readback:2:end', 'mark')).toHaveLength(0);
    expect(performance.getEntriesByName('maple:scope-readback', 'measure')).toHaveLength(0);
  });

  it('still clears its marks even when the wrapped fn() throws (jules review, #1123)', () => {
    // Second regression jules flagged: the original `markScopeReadback` called
    // `fn()` outside any try/finally, so a throw from the readback ITSELF (not
    // just a Performance Timeline call) skipped markEnd + the clears, leaking
    // `startMark`. The caller's exception must still propagate.
    expect(() =>
      markScopeReadback(4, () => {
        throw new Error('simulated readback failure');
      }),
    ).toThrow('simulated readback failure');
    expect(performance.getEntriesByName('maple:scope-readback:4:start', 'mark')).toHaveLength(0);
    expect(performance.getEntriesByName('maple:scope-readback:4:end', 'mark')).toHaveLength(0);
  });

  it('still clears its marks even when performance.measure throws (the BLOCKING fix)', () => {
    // Regression for the jules-review BLOCKING finding: the original fix bundled
    // mark(end) + measure + clearMarks + clearMeasures into ONE safeMeasure closure,
    // so a `measure` throw (e.g. the start mark was cleared out from under it)
    // silently skipped every clear that came after it — leaking the end mark (and
    // any prior measure) into the buffer forever. `markScopeReadback` must clear
    // both marks regardless.
    const originalMeasure = performance.measure;
    performance.measure = vi.fn(() => {
      throw new DOMException("mark 'maple:scope-readback:3:start' does not exist", 'SyntaxError');
    }) as unknown as typeof performance.measure;
    try {
      expect(() => markScopeReadback(3, () => undefined)).not.toThrow();
    } finally {
      performance.measure = originalMeasure;
    }
    // The end mark still gets placed before the throwing measure call — it must be
    // cleared regardless of the throw.
    expect(performance.getEntriesByName('maple:scope-readback:3:start', 'mark')).toHaveLength(0);
    expect(performance.getEntriesByName('maple:scope-readback:3:end', 'mark')).toHaveLength(0);
  });
});
