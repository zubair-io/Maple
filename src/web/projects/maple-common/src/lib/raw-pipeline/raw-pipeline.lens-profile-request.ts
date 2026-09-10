// Main-thread side of imported lens profiles (#3479) — extracted from
// `raw-pipeline.service.ts` so that file stays inside the file-size budget.
// Mirrors `raw-pipeline.auto-adjust-request.ts`: pure functions over the
// worker plus the service's pending-handler registry; the service keeps
// ownership of the `decodeChain` gate (the import decodes the RAW in the
// worker, so it must not overlap another decode in the WASM heap).

import type { Injector } from '@angular/core';
import type {
  ImportedLensProfile,
  LensProfileFetch,
  LensProfileRequest,
} from '../lens/lens-profile.types';
import type { RegisterPending } from './raw-pipeline.dispatch-with-mark';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';

/** Post one import request; resolves with the registered profile + its resolution. */
export function dispatchImportLensProfile(
  worker: Worker,
  id: number,
  register: RegisterPending,
  xml: string,
  bytes: Uint8Array,
  ext: string,
): Promise<ImportedLensProfile> {
  // Copy off the caller's view before transferring (mirrors `decodeOnce`).
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const request: LensProfileRequest = { id, type: 'import-lens-profile', xml, bytes: buffer, ext };
  return dispatchWithMark<ImportedLensProfile>(
    worker,
    request,
    [buffer],
    'maple:import-lens-profile',
    ({ resolve, reject }) => ({ kind: 'lens-profile', resolve, reject }),
    register,
  );
}

/**
 * Complete the worker's cache-fetch handshake: Self Hosted copies the
 * server's bytes into IndexedDB first, Hosted has nowhere else to look.
 * Either way the worker is told to re-read its cache; raw-core owns the
 * missing-profile error if the render needed the bytes.
 */
export function restoreRequestedLensProfile(
  worker: Worker,
  request: LensProfileFetch,
  injector: Injector,
  selfHosted: boolean,
): void {
  const restore = selfHosted
    ? import('../lens/lens-profile-server-bridge').then((bridge) =>
        bridge.restoreServerLensProfile(injector, request.reference),
      )
    : Promise.resolve();
  void restore
    .catch(() => undefined)
    .finally(() => worker.postMessage({ id: request.id, type: 'lens-profile-restored' }));
}
