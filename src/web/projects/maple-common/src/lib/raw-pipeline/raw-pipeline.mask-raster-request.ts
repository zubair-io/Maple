// Dispatch helpers for the bitmap-mask raster registry (#3300) — same shape
// as `raw-pipeline.sample-wb-request.ts`.

import type { RegisterPending } from './raw-pipeline.dispatch-with-mark';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';
import type {
  MaskRasterUpload,
  RegisterMaskRasterRequest,
  ReleaseMaskRasterRequest,
} from './raw-pipeline.mask-raster.types';
import type {
  BrushRasterUpload,
  RegisterBrushRasterRequest,
} from './raw-pipeline.brush-raster.types';

/**
 * Post one raster to the worker's registry and resolve with its raster id.
 * The bytes are copied off the caller's view before transferring, so the
 * caller's own buffer (a cached raster it may re-register after a worker
 * restart) stays usable.
 */
export function dispatchRegisterMaskRaster(
  worker: Worker,
  id: number,
  register: RegisterPending,
  { digest, width, height, data }: MaskRasterUpload,
): Promise<number> {
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
  const request: RegisterMaskRasterRequest = {
    id,
    type: 'register-mask-raster',
    digest,
    width,
    height,
    data: buffer,
  };
  return dispatchWithMark<number>(
    worker,
    request,
    [buffer],
    'maple:register-mask-raster',
    ({ resolve, reject }) => ({ kind: 'register-mask-raster', resolve, reject }),
    register,
  );
}

/** Forget a registered raster. Fire-and-forget — the worker sends no reply. */
export function releaseMaskRasterRequest(worker: Worker, id: number, rasterId: number): void {
  const request: ReleaseMaskRasterRequest = { id, type: 'release-mask-raster', rasterId };
  worker.postMessage(request);
}

/**
 * Post one dab series to the worker's registry and resolve with its raster
 * id (#360). The dab wire is copied off the caller's view before
 * transferring, so the caller's own array (a stroke it may re-register
 * after a worker restart) stays usable.
 */
export function dispatchRegisterBrushRaster(
  worker: Worker,
  id: number,
  register: RegisterPending,
  { digest, width, height, dabs }: BrushRasterUpload,
): Promise<number> {
  const buffer = dabs.buffer.slice(
    dabs.byteOffset,
    dabs.byteOffset + dabs.byteLength,
  ) as ArrayBuffer;
  const request: RegisterBrushRasterRequest = {
    id,
    type: 'register-brush-raster',
    digest,
    width,
    height,
    dabs: buffer,
  };
  return dispatchWithMark<number>(
    worker,
    request,
    [buffer],
    'maple:register-brush-raster',
    ({ resolve, reject }) => ({ kind: 'register-brush-raster', resolve, reject }),
    register,
  );
}
