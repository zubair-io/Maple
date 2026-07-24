// raw-pipeline.perf.ts
//
// #1123: `performance.mark`/`performance.measure` are diagnostics-only, but
// `performance.measure` THROWS if either named mark was cleared out from under it
// (DevTools' `performance.clearMarks()`, a monitoring shim, or a test harness can do
// this at any time — the Performance Timeline is a single shared, mutable buffer, not
// something either the service or the worker owns exclusively). Every decode/session/
// auto-adjust call chains its `resolve`/response-post AFTER a mark+measure pair on the
// main thread and inside the worker's response-building `try`; an uncaught throw there
// means `resolve` (main thread) or the success `postMessage` (worker, before its outer
// `catch` mislabels a successful render as an error) never runs. On the main thread,
// decodes are serialized behind `RawPipelineService.decodeChain`, so one stranded
// `resolve` deadlocks every later decode — the editor spins on "Decoding RAW…" forever.
//
// `safeMeasure` isolates a SINGLE Performance Timeline call so a throw there can never
// block the caller's control flow. `markStart`/`markEnd`/`markScopeReadback` build on
// it for the two repeated bookkeeping shapes in raw-pipeline.service.ts and
// raw-pipeline.worker.ts:
//   - a "start mark → do work → end mark + measure" span (markStart / markEnd)
//   - the worker's scope-readback span, which ALSO clears its own marks/measure
//     immediately after so nothing accumulates across a slider drag
//     (markScopeReadback)
//
// `markScopeReadback` gives every one of ITS Performance Timeline calls — the clears
// included — its OWN `safeMeasure`, deliberately: an earlier version of this fix
// bundled mark(end)+measure+clearMarks+clearMeasures into a SINGLE `safeMeasure`
// closure, so a `measure` throw (a cleared start mark) silently skipped the clears
// that came after it in the same closure — leaking marks into the worker's
// performance-entry buffer forever (jules review, #1123).

let lastWarnAt = -Infinity;
// A persistent mark-clearer (a monitoring shim, a flaky test harness) could otherwise
// make every decode/render/readback tick log — several times a second during a slider
// drag — and synchronous console output on that hot path works against the 16ms
// slider-tick budget. Cap it to one warning per second; the failure is diagnostics-only
// and already fully handled by the caller continuing past it.
const WARN_THROTTLE_MS = 1000;

export function safeMeasure(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const now = Date.now();
    if (now - lastWarnAt < WARN_THROTTLE_MS) return;
    lastWarnAt = now;
    console.warn('[raw-pipeline] performance measurement failed (ignored):', err);
  }
}

/** Test-only: clear the warn throttle so a spec can assert on a fresh `console.warn`. */
export function resetSafeMeasureWarnThrottleForTests(): void {
  lastWarnAt = -Infinity;
}

/** Place `startMark`. The first half of a mark-start/mark-end-and-measure span. */
export function markStart(startMark: string): void {
  safeMeasure(() => performance.mark(startMark));
}

/** Place `endMark` and record a `measureName` span from `startMark` to it. */
export function markEnd(startMark: string, endMark: string, measureName: string): void {
  safeMeasure(() => performance.mark(endMark));
  safeMeasure(() => performance.measure(measureName, startMark, endMark));
}

/**
 * Time a synchronous scope readback and immediately clear its own marks/measure
 * so nothing accumulates in the worker's performance-entry buffer across a slider
 * drag. Every Performance Timeline call below — the clears included — runs in its
 * OWN `safeMeasure` (see module doc): a throw from `measure` must never suppress
 * a clear that comes after it.
 */
export function markScopeReadback<T>(id: number, fn: () => T): T {
  const startMark = `maple:scope-readback:${id}:start`;
  const endMark = `maple:scope-readback:${id}:end`;
  const measureName = 'maple:scope-readback';
  markStart(startMark);
  const result = fn();
  markEnd(startMark, endMark, measureName);
  safeMeasure(() => performance.clearMarks(startMark));
  safeMeasure(() => performance.clearMarks(endMark));
  safeMeasure(() => performance.clearMeasures(measureName));
  return result;
}
