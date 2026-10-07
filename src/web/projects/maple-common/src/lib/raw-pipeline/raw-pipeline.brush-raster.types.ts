// Brush-raster registration (#360) — worker request/response shapes.
// Split from `raw-pipeline.types.ts` (at its file budget), like
// `raw-pipeline.mask-raster.types.ts`; that file's `WorkerRequest` /
// `WorkerResponse` unions reference these.
//
// One call rasterizes AND registers: the main thread hands over the dab
// series, the worker stamps it (`brush_raster_register` in wasm) straight
// into the instance registry, and the id comes back. The ~1 MB stroke bytes
// never cross the JS↔wasm boundary in either direction.

/** What the main thread hands `RawPipelineService.registerBrushRaster`. */
export interface BrushRasterUpload {
  /** 16 lowercase hex chars — the host-minted `BrushMask.digest`. */
  digest: string;
  width: number;
  height: number;
  /** Flat dab wire, 6 `f32`s per dab (`x, y, radius, feather, weight, erase`). */
  dabs: Float32Array;
}

/** Main thread → worker: rasterize one dab series and register it under `digest`. */
export interface RegisterBrushRasterRequest {
  id: number;
  type: 'register-brush-raster';
  /** 16 lowercase hex chars — the host-minted `BrushMask.digest`. */
  digest: string;
  width: number;
  height: number;
  /** Flat dab wire, 6 `f32`s per dab. Transferable. */
  dabs: ArrayBuffer;
}

/** Worker → main thread: the raster is registered under `rasterId` (>= 1). */
export interface RegisterBrushRasterSuccess {
  id: number;
  type: 'register-brush-raster-success';
  rasterId: number;
}

/** Worker → main thread: the WASM entry rejected the upload (bad digest, a
 *  malformed dab wire). */
export interface RegisterBrushRasterError {
  id: number;
  type: 'register-brush-raster-error';
  message: string;
}
