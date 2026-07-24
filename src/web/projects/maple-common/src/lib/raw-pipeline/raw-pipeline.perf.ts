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
// `safeMeasure` isolates the bookkeeping so a Performance Timeline hiccup can never
// block (main thread) or misreport (worker) the actual result.
export function safeMeasure(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn('[raw-pipeline] performance measurement failed (ignored):', err);
  }
}
