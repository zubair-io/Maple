// Bitmap-mask raster registry (#3300) — worker request/response shapes.
// Split from `raw-pipeline.types.ts` (at its file budget); that file's
// `WorkerRequest` / `WorkerResponse` unions reference these.
//
// The web mirror of raw-ffi's `maple_mask_raster_register` / `_release`: a
// `bitmap` mask's raster never rides the sidecar or the per-tick render
// request — the host registers it ONCE with the worker's WASM instance,
// gets back an id, and every render entry (the persistent GPU session, the
// one-shot CPU/GPU decodes, export) resolves the mask's recipe `digest`
// against that one process-wide table. A digest nobody registered renders
// as weight 0 — never a silent whole-image correction.

/** What the main thread hands `RawPipelineService.registerMaskRaster`. */
export interface MaskRasterUpload {
  /** 16 lowercase hex chars — `BitmapRecipe.digest`. */
  digest: string;
  width: number;
  height: number;
  /** Row-major `width * height` bytes, `0` = weight 0, `255` = weight 1. */
  data: Uint8Array;
}

/** Main thread → worker: register one R8 raster under its recipe digest. */
export interface RegisterMaskRasterRequest {
  id: number;
  type: 'register-mask-raster';
  /** 16 lowercase hex chars — `BitmapRecipe.digest`. */
  digest: string;
  width: number;
  height: number;
  /** Row-major `width * height` bytes, `0` = weight 0, `255` = weight 1. Transferable. */
  data: ArrayBuffer;
}

/** Worker → main thread: the raster is registered under `rasterId` (>= 1). */
export interface RegisterMaskRasterSuccess {
  id: number;
  type: 'register-mask-raster-success';
  rasterId: number;
}

/** Worker → main thread: the WASM entry rejected the raster (bad digest,
 *  `data.length !== width * height`). */
export interface RegisterMaskRasterError {
  id: number;
  type: 'register-mask-raster-error';
  message: string;
}

/** Main thread → worker: forget a registered raster. Fire-and-forget (no reply). */
export interface ReleaseMaskRasterRequest {
  id: number;
  type: 'release-mask-raster';
  rasterId: number;
}
