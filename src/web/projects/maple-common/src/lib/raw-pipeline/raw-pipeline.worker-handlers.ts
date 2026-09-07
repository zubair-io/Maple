// raw-pipeline.worker-handlers.ts
// Extracted from raw-pipeline.worker.ts (pure code move — no behaviour change).
// Contains: WebLiveSession interface declarations, the shared WASM-init
// gate (`ensureReady`) — hoisted here (rather than staying in
// raw-pipeline.worker.ts) so raw-pipeline.session-handler.ts can depend on it
// without an import cycle back through the main worker entry (#2683 split,
// file-size budget).

import * as wasm from './pkg/raw_wasm';
import type { WebScopePixels } from './raw-pipeline.scope-colors';
import { initRawWasm, type RawWasmInitResult } from './raw-wasm-init';
import type { DeepDenoiseProgress, WorkerResponse } from './raw-pipeline.types';

/**
 * #1153: hand raw-core's BM3D stage progress to the main thread.
 *
 * `setDeepDenoiseProgress` is a plain (non-gpu-gated) export of the WASM
 * bundle, but read dynamically for the same reason `render_bytes_gpu` is:
 * a bundle built before #1153 simply omits it, and a missing determinate
 * bar must not break decoding. Ticks only fire while `deepDenoise > 0`
 * engages the stage, so a session that never touches Deep pays nothing.
 *
 * The develop runs SYNCHRONOUSLY here, so the worker cannot answer a poll
 * while it is in flight — but this outgoing `postMessage` still lands on
 * the main thread's (unblocked) event loop, which is why the direction is
 * push, not pull.
 */
function installDeepDenoiseProgress(): void {
  const register = Reflect.get(wasm as object, 'setDeepDenoiseProgress');
  if (typeof register !== 'function') return;
  (register as (cb: (pass: string, fraction: number) => void) => void)((pass, fraction) => {
    const msg: DeepDenoiseProgress = {
      id: 0,
      type: 'deep-denoise-progress',
      pass: pass === 'pass 2/2' ? 2 : 1,
      fraction,
    };
    (self as unknown as Worker).postMessage(msg);
  });
}

let readyPromise: Promise<RawWasmInitResult> | null = null;

/** Ensure the WASM module is initialised, broadcasting the thread-pool status
 *  once. Shared by every handler (legacy decode, scene-linear decode,
 *  session, auto-adjust) so init is kicked off eagerly and awaited lazily —
 *  no handler waits for a decode request before starting init. */
export function ensureReady(): Promise<RawWasmInitResult> {
  if (!readyPromise) {
    readyPromise = initRawWasm().then((result) => {
      installDeepDenoiseProgress();
      // Report the runtime policy result so the UI can surface serial mode on
      // non-isolated hosts and on Chromium while #2515 is mitigated.
      const statusMsg: WorkerResponse = {
        id: 0,
        type: 'status',
        threaded: result.threaded,
        threads: result.threads,
      };
      (self as unknown as Worker).postMessage(statusMsg);
      return result;
    });
  }
  return readyPromise;
}

/**
 * The `WebLiveSession` class from the `gpu`-feature WASM build (#1038). Typed
 * locally (the default bundle omits it); read off the module namespace and
 * existence-checked. `open` is a static async constructor; the instance exposes an
 * async `render(xmp)` and getters for dims + As-Shot WB.
 */
export interface WebLiveSessionInstance {
  /** Owns its map independently of the mutable render Promise. */
  sample_scope(): Promise<WebScopePixels>;
  render(xmp: string | null): Promise<string>;
  /** Flat-params hot path (avoids XML parsing per tick); see `render`. */
  render_with_params(params: Float32Array): Promise<string>;
  /**
   * Load (or replace) the session's film-look LUT (epic #2683, Task 9).
   * `bytes` is a `.mlut` v1 buffer; `lookKey` is the content-identity key
   * folded into the GPU chain signature. Empty `bytes` clears the look.
   * Does not itself re-render — takes effect on the next `render` /
   * `render_with_params` tick.
   */
  set_film_lut(bytes: Uint8Array, lookKey: number): void;
  /** Drop the session's film-look LUT — the next tick renders with none. */
  clear_film_lut(): void;
  /** Developed (viewport-sized per #1080) dims == the canvas dims. */
  readonly width: number;
  readonly height: number;
  /** Native oriented dims — what a full-res render would produce (#1080). */
  readonly fullWidth: number;
  readonly fullHeight: number;
  readonly asShotTemperature: number;
  readonly asShotTint: number;
  /** See `DecodeSuccess.hasLensCorrections` (#3182) — read off the session's
   *  retained `RawImage`; a decode-time fact, unchanged across re-develops. */
  readonly hasLensCorrections: boolean;
  /** See `DecodeSuccess.lensCorrectionCaInert` (#3182). */
  readonly lensCorrectionCaInert: boolean;
  readonly cameraSupportJson: string | undefined;
  readonly colorSpace: string;
  free(): void;
}
export interface WebLiveSessionCtor {
  open(
    raw: Uint8Array,
    ext: string,
    xmp: string | null,
    canvas: OffscreenCanvas,
    // Viewport target in real pixels (#1080): the session develop fits the
    // image to this long edge and sizes the canvas to the developed dims.
    // undefined => the WASM-side 2048 default cap.
    maxLongEdge?: number,
    // Requested canvas colour space (#3191) — 'display-p3' | 'srgb'.
    // undefined => the WASM-side 'display-p3' default.
    targetColorSpace?: string,
  ): Promise<WebLiveSessionInstance>;
}
