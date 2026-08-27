// Shared "post one request, mark the round trip, register the pending
// handler" boilerplate — factored out of `raw-pipeline.export-request.ts`,
// `raw-pipeline.auto-adjust-request.ts`, and `raw-pipeline.develop-non-raw-request.ts`
// (#3039 review — the third near-identical copy is what a duplication scan
// flags; this collapses all three into one shared body). Every one of those
// dispatch functions still owns its OWN request-shape construction (bytes,
// transfer list, request type) and its own `PendingHandler` variant — this
// only owns the part that was byte-for-byte identical across all three: post
// before register (a synchronous `postMessage` throw must never strand a
// pending-map entry no worker reply can settle), and the perf-mark bracket
// around the round trip.

import type { PendingHandler } from './raw-pipeline.service-internals';
import { markStart, markEnd } from './raw-pipeline.perf';

/** Registers a pending handler against a correlation id. */
export type RegisterPending = (id: number, handler: PendingHandler) => void;

/**
 * Post `request` to `worker` (transferring `transfer`), bracket the round
 * trip with a perf mark, and register the pending handler `buildHandler`
 * produces — POSTING BEFORE REGISTERING so a synchronous `postMessage` throw
 * (terminated worker / untransferable payload) can't leave an orphaned
 * pending entry and an unmatched `markStart`.
 *
 * `measureName` is the STABLE per-call-site measure name (e.g.
 * `'maple:auto-adjust'`) DevTools groups every call under — it must NOT
 * include `request.id`, unlike the start/end MARK names this derives from it
 * (`` `${measureName}:${request.id}:start` `` / `:end`), which do, so
 * concurrent in-flight requests don't collide on the same mark name.
 *
 * `buildHandler` receives the settle functions (already wrapped to fire
 * `markEnd` first) and returns the full `PendingHandler` — the caller picks
 * the `kind` discriminant and the exact resolve/reject signature for its own
 * response shape; this function only owns the transport, not the reply
 * contract.
 */
export function dispatchWithMark<TResult>(
  worker: Worker,
  request: { id: number },
  transfer: Transferable[],
  measureName: string,
  buildHandler: (settle: {
    resolve: (result: TResult) => void;
    reject: (reason: unknown) => void;
  }) => PendingHandler,
  register: RegisterPending,
): Promise<TResult> {
  const startMark = `${measureName}:${request.id}:start`;
  const endMark = `${measureName}:${request.id}:end`;
  markStart(startMark);
  return new Promise<TResult>((resolve, reject) => {
    try {
      worker.postMessage(request, transfer);
    } catch (err) {
      markEnd(startMark, endMark, measureName);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    register(
      request.id,
      buildHandler({
        resolve: (result) => {
          markEnd(startMark, endMark, measureName);
          resolve(result);
        },
        reject,
      }),
    );
  });
}
