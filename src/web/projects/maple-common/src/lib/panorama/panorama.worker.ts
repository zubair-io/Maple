// panorama.worker.ts — Single-purpose Web Worker for panorama stitching.
//
// Owns a pano-enabled raw-wasm instance off the main thread so that a
// multi-second stitch operation never blocks the UI.
//
// RPC protocol (postMessage):
//   Main → Worker  { id: number; type: 'stitch'; images: ArrayBuffer[];
//                    options: { projection: number; parallaxMode: number;
//                               maxDimension: number } }
//
//   Worker → Main  { id: number; ok: true; width: number; height: number;
//                    pixelsF16: ArrayBuffer }          // transferable
//                | { id: number; ok: false; error: string }
//
// Build note:
//   This worker requires the raw-wasm bundle built with --features pano:
//     cd src/raw-pipeline/raw-wasm
//     wasm-pack build --target web --features pano
//   then sync into the Angular workspace:
//     ./src/web/scripts/sync-raw-wasm.sh
//   The default bundle (no --features pano) omits PanoHandle.stitch and the
//   worker will throw "TypeError: PanoHandle.stitch is not a function".
//
// Phase D note:
//   This is a single-purpose worker for panorama stitching (T5.5).  When a
//   Phase D worker protocol ships it can absorb or replace this worker.

/// <reference lib="webworker" />

import init, { PanoHandle, PanoramaOptions } from '../raw-pipeline/pkg/raw_wasm';

// ---------------------------------------------------------------------------
// RPC types (inlined — no shared import from panorama.types.ts needed yet)
// ---------------------------------------------------------------------------

interface StitchRequest {
  id: number;
  type: 'stitch';
  /** PNG or JPEG byte buffers, one per input image. */
  images: ArrayBuffer[];
  options: {
    /** 0 = rectilinear, 1 = cylindrical (default), 2 = spherical */
    projection: number;
    /** 0 = homography (default), 1 = TPS */
    parallaxMode: number;
    /** 0 = unconstrained */
    maxDimension: number;
  };
}

interface StitchSuccess {
  id: number;
  ok: true;
  width: number;
  height: number;
  /** f16 interleaved RGB; transferred (zero-copy). */
  pixelsF16: ArrayBuffer;
}

interface StitchError {
  id: number;
  ok: false;
  error: string;
}

type WorkerReply = StitchSuccess | StitchError;

// ---------------------------------------------------------------------------
// WASM initialisation (lazy, shared across all incoming requests)
// ---------------------------------------------------------------------------

let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (init as unknown as () => Promise<void>)().catch((err) => {
      // Reset so the next request retries.
      initPromise = null;
      return Promise.reject(err);
    });
  }
  return initPromise;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (event: MessageEvent<StitchRequest>) => {
  const { id, type } = event.data;

  if (type !== 'stitch') {
    (self as unknown as Worker).postMessage({
      id,
      ok: false,
      error: `panorama.worker: unknown request type "${type}"`,
    } satisfies StitchError);
    return;
  }

  try {
    await ensureInit();

    const { images, options } = event.data;

    if (!images || images.length < 2) {
      throw new Error('panorama.worker: stitch requires at least 2 images');
    }

    // Build the JS array of Uint8Array entries expected by PanoHandle.stitch.
    // Each entry was transferred as a plain ArrayBuffer.
    const imageArray = images.map((buf) => new Uint8Array(buf));

    // Build PanoramaOptions from the plain-object payload.
    const opts = new PanoramaOptions();
    opts.projection = options.projection ?? 1;
    opts.parallax_mode = options.parallaxMode ?? 0;
    opts.max_dimension = options.maxDimension ?? 0;

    // Run the stitch — this is the blocking call (seconds on large inputs).
    // It executes here inside the worker so the main thread stays responsive.
    const handle = PanoHandle.stitch(imageArray, opts);

    // Call pixelsF16() exactly once (clone of the wasm heap — see tech-debt
    // comment in raw-wasm/src/lib.rs).  Transfer the backing buffer to avoid
    // a second copy on the structured-clone step.
    const f16 = handle.pixelsF16();
    const buf = f16.buffer.slice(f16.byteOffset, f16.byteOffset + f16.byteLength);

    const reply: StitchSuccess = {
      id,
      ok: true,
      width: handle.width,
      height: handle.height,
      pixelsF16: buf,
    };
    (self as unknown as Worker).postMessage(reply, [buf]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reply: StitchError = { id, ok: false, error: message };
    (self as unknown as Worker).postMessage(reply);
  }
};
