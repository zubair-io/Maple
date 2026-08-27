// Persistent GPU live-session request dispatch (epic #925, P4b-web / #1038) —
// extracted from `raw-pipeline.service.ts` so that file stays inside the
// file-size budget headroom (tools/check-budget-headroom.sh). Mirrors
// `raw-pipeline.non-raw-develop.ts` / `raw-pipeline.decode-route.ts`: pure
// functions over the pieces `RawPipelineService` owns (the worker, the id
// counter, the pending-handler registry), not methods on the class itself.
//
// `RawPipelineService.openLiveSession`/`renderLiveSession`/`closeLiveSession`
// keep ownership of `ensureWorker()`'s try/catch (these three requests are
// NOT behind the `decodeChain` serialization gate — the session lives
// entirely in the worker and owns its own render queue) and just delegate
// the request body here.

import type {
  CloseSessionRequest,
  OpenSessionRequest,
  RenderSessionRequest,
} from './raw-pipeline.types';
import type { OpenedLiveSession, RenderedLiveSession } from './raw-pipeline.service-internals';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';
import type { RegisterPending } from './raw-pipeline.export-request';

/**
 * Open a persistent GPU live session for `bytes`, transferring `canvas` (an
 * `OffscreenCanvas` from `transferControlToOffscreen()`) to the worker. The
 * first frame is presented to the canvas before this resolves. Rejects if
 * the loaded WASM bundle lacks the `gpu` feature (the caller falls back to
 * `decode()`), or on a decode / GPU error.
 *
 * The transferred `canvas` is owned by the worker after this call; the
 * caller must not draw to it on the main thread.
 *
 * @param maxLongEdge Viewport target in REAL (backing-store) pixels
 *   (#1080): the session's develop fits the image to this long edge (aspect
 *   preserved, never upscaled) and sizes the canvas to the developed dims.
 *   Absent ⇒ the WASM-side 2048 default cap (the downlevel WebGPU texture
 *   baseline). The reply carries the NATIVE oriented dims in
 *   `nativeWidth`/`nativeHeight`.
 */
export function openLiveSessionRequest(
  worker: Worker,
  id: number,
  register: RegisterPending,
  canvas: OffscreenCanvas,
  bytes: Uint8Array,
  ext: string,
  xmp: string | undefined,
  maxLongEdge: number | undefined,
): Promise<OpenedLiveSession> {
  // Copy the bytes off the caller's view before transferring (the view stays
  // usable for a later 2D fallback / re-open), mirroring `decodeOnce`.
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const request: OpenSessionRequest = {
    id,
    type: 'open-session',
    bytes: buffer,
    ext,
    xmp,
    canvas,
    maxLongEdge,
  };
  // Transfer BOTH the byte buffer and the OffscreenCanvas to the worker.
  return dispatchWithMark<OpenedLiveSession>(
    worker,
    request,
    [buffer, canvas],
    'maple:open-session',
    ({ resolve, reject }) => ({ kind: 'open-session', resolve, reject }),
    register,
  );
}

/**
 * Re-render the open live session for the develop model serialized in `xmp`
 * and present to the canvas (the #846 edit path). Resolves with the
 * achieved canvas colour-space tag plus an optional downsampled scope
 * readback of the presented frame (#1045). Rejects if no session is open or
 * on a GPU error. The worker serializes these against each other + the open.
 */
export function renderLiveSessionRequest(
  worker: Worker,
  id: number,
  register: RegisterPending,
  xmp: string | undefined,
  params: Float32Array | undefined,
): Promise<RenderedLiveSession> {
  const request: RenderSessionRequest = { id, type: 'render-session', xmp, params };
  return dispatchWithMark<RenderedLiveSession>(
    worker,
    request,
    params ? [params.buffer] : [],
    'maple:render-session',
    ({ resolve, reject }) => ({ kind: 'render-session', resolve, reject }),
    register,
  );
}

/**
 * Tear down the open live session (asset switch / component destroy).
 * Fire-and-forget — the worker frees the handle behind its render queue (so
 * it never frees while a render holds the borrow).
 */
export function closeLiveSessionRequest(worker: Worker, id: number): void {
  const request: CloseSessionRequest = { id, type: 'close-session' };
  worker.postMessage(request);
}
