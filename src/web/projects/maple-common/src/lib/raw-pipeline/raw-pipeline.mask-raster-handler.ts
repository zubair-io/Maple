/// <reference lib="webworker" />
// Worker-side bitmap-mask raster registry (#3300).
//
// Own file, like `raw-pipeline.sample-wb-handler.ts`, to keep
// `raw-pipeline.worker.ts` inside its size budget. Both entries are
// synchronous on the wasm side and touch only the registry — never the live
// session's `&mut self` — so they run straight off the message queue; the
// worker processes messages in order, so a `render-session` posted after a
// `register-mask-raster` always sees the raster.

import { mask_raster_register, mask_raster_release } from './pkg/raw_wasm';
import type {
  RegisterMaskRasterRequest,
  ReleaseMaskRasterRequest,
} from './raw-pipeline.mask-raster.types';
import type { WorkerResponse } from './raw-pipeline.types';
import { ensureReady } from './raw-pipeline.worker-handlers';

/** Register the request's raster and reply with the id it resolves under. */
export async function handleRegisterMaskRaster(req: RegisterMaskRasterRequest): Promise<void> {
  try {
    await ensureReady();
    const rasterId = mask_raster_register(
      req.digest,
      req.width,
      req.height,
      new Uint8Array(req.data),
    );
    const response: WorkerResponse = { id: req.id, type: 'register-mask-raster-success', rasterId };
    (self as unknown as Worker).postMessage(response);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const response: WorkerResponse = { id: req.id, type: 'register-mask-raster-error', message };
    (self as unknown as Worker).postMessage(response);
  }
}

/** Forget a raster. No reply — the caller has nothing to wait for. */
export async function handleReleaseMaskRaster(req: ReleaseMaskRasterRequest): Promise<void> {
  await ensureReady();
  mask_raster_release(req.rasterId);
}
