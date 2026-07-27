// Auto-adjust request dispatch (#1379) — extracted from `raw-pipeline.service.ts`
// so that file stays inside the 600-line hard budget.
//
// Mirrors `raw-pipeline.export-request.ts`: a pure function over the worker plus
// the service's pending-handler registry. `RawPipelineService.computeAutoAdjustments`
// keeps ownership of the `decodeChain` serialisation gate and just delegates the
// round trip here.

import type { RegisterPending } from './raw-pipeline.export-request';
import type { AutoAdjustPatch, AutoAdjustRequest } from './raw-pipeline.types';
import { markStart, markEnd } from './raw-pipeline.perf';

/**
 * Post one auto-adjust request and resolve with the 8-field recommendation.
 *
 * The RAW bytes are copied off the caller's view before being transferred, so
 * the caller's `Uint8Array` stays usable for a later decode or re-open (mirrors
 * `decodeOnce`).
 *
 * IMPORTANT: the returned `exposure` was measured against an AE-Off probe, so
 * the caller must set `autoExposure: 'Off'` alongside it — see the WASM module
 * doc in `raw-wasm/src/auto_adjustments.rs` for the full contract.
 */
export function dispatchAutoAdjust(
  worker: Worker,
  id: number,
  register: RegisterPending,
  bytes: Uint8Array,
  ext: string,
  xmp: string | undefined,
): Promise<AutoAdjustPatch> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const request: AutoAdjustRequest = { id, type: 'auto-adjust', bytes: buffer, ext, xmp };
  // #1123: markStart/markEnd — see decodeOnce; a throw here must never strand
  // `resolve`.
  const startMark = `maple:auto-adjust:${id}:start`;
  const endMark = `maple:auto-adjust:${id}:end`;
  markStart(startMark);
  return new Promise<AutoAdjustPatch>((resolve, reject) => {
    // Post BEFORE registering. `postMessage` throws synchronously on a
    // terminated worker (`InvalidStateError`) and on an untransferable
    // payload (`DataCloneError`); registering first would leave an entry in
    // the service's pending map that no worker reply can ever settle, and a
    // `markStart` with no matching `markEnd`. The Promise itself does settle
    // either way — a throw from this executor rejects it — so the leak is
    // the registry and the mark, not a hung caller.
    //
    // Safe to post first: the worker's reply arrives as a queued message
    // event, which cannot be dispatched until this synchronous executor has
    // returned, so `register` always lands before any response can look the
    // handler up.
    try {
      worker.postMessage(request, [buffer]);
    } catch (err) {
      markEnd(startMark, endMark, 'maple:auto-adjust');
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    register(id, {
      kind: 'auto-adjust',
      resolve: (patch) => {
        markEnd(startMark, endMark, 'maple:auto-adjust');
        resolve(patch);
      },
      reject,
    });
  });
}
