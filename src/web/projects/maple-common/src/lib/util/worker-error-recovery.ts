/** Anything a pending request map's value needs for error recovery: a way
 * to reject the caller waiting on it. */
export interface RejectablePending {
  reject: (err: Error) => void;
}

/**
 * Wire a dedicated single-purpose Worker's `error` event (script load
 * failure, uncaught exception in the worker) to a standard recovery: reject
 * every entry in `pending`, clear the map, terminate the broken worker
 * instance, and let the caller null out its own reference (`onRecovered`)
 * so the next `ensureWorker()`-style call creates a fresh one.
 *
 * Shared by `MapleIdFallbackHasherService` and `EmbeddedPreviewService` —
 * both wrap a small dedicated worker (deliberately separate from
 * `raw-pipeline.worker.ts`'s decode/live-render worker, see each service's
 * module doc) with the identical "one bad worker load shouldn't leave
 * abandoned pending promises" recovery shape. Extracted here once both had
 * it, rather than upfront, per this repo's YAGNI convention (generalize
 * when a second real caller forces it).
 */
export function wireWorkerErrorRecovery<T extends RejectablePending>(
  worker: Worker,
  errorPrefix: string,
  pending: Map<number, T>,
  onRecovered: () => void,
): void {
  worker.addEventListener('error', (event) => {
    const message = event.message || 'unknown error';
    const err = new Error(`${errorPrefix}: ${message}`);
    pending.forEach((entry) => entry.reject(err));
    pending.clear();
    // Terminate the broken instance before dropping the reference —
    // without this, a worker that errored keeps running abandoned rather
    // than being cleaned up, and only the caller's reference gets replaced
    // on its next ensure-worker call.
    worker.terminate();
    onRecovered();
  });
}
