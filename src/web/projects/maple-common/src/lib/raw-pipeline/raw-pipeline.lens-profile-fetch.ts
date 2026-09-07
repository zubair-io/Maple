import type { Injector } from '@angular/core';
import type { LensProfileFetch } from '../lens/lens-profile.types';

/** Complete the worker's cache-fetch handshake; the core owns missing-profile errors. */
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
