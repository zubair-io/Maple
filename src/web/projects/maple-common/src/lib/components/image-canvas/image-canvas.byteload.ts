// image-canvas.byteload.ts — async byte-fetch + recoverable-error handling
// for the decode effect's Self-Hosted/backend-resolvable branch (#1562).
//
// `LibraryCache` already retries a transient byte-fetch failure internally
// (`library-cache.byte-retry.ts`), but a failure that survives those retries
// — or a non-transient one (404/403) — used to leave a silently blank canvas:
// the decode effect only wrote a `console.error`, with no user-visible state
// and no way to recover short of navigating away and back (#2407).
// `fetchAndLoadBytes` records a named, retryable error on `host.byteLoadError`
// instead; the canvas template renders it and a Retry button re-invokes this
// same function, clearing the error first so a stale rejection can't linger.

import type { WritableSignal } from '@angular/core';
import type { AssetId } from '../../models/asset';
import type { LibraryStateService } from '../../state/library-state.service';
import type { ImageCanvasService } from './image-canvas.service';

export interface ByteLoadHost {
  currentAssetId: AssetId | null;
  readonly imageBitmap: WritableSignal<ImageBitmap | null>;
  readonly byteLoadError: WritableSignal<{ id: AssetId; filename: string } | null>;
  readonly state: Pick<LibraryStateService, 'bytesForAsset'>;
  readonly canvasSvc: Pick<ImageCanvasService, 'currentPixels'>;
  loadReal(assetId: AssetId, filename: string, bytes: Uint8Array): Promise<void>;
}

/** Kick off (or retry) the async byte fetch for `assetId`. On success, decodes
 *  and paints via `host.loadReal`; on failure, records a recoverable error
 *  instead of leaving the canvas blank. A stale-id guard (checked in both
 *  continuations) drops the result if the user has since moved to a
 *  different asset. */
export function fetchAndLoadBytes(host: ByteLoadHost, assetId: AssetId, filename: string): void {
  host.imageBitmap.set(null);
  host.canvasSvc.currentPixels.set(null);
  host.byteLoadError.set(null);
  host.state
    .bytesForAsset(assetId)
    .then((fetched) => {
      if (host.currentAssetId !== assetId) return; // user moved on
      void host.loadReal(assetId, filename, fetched);
    })
    .catch((err: unknown) => {
      if (host.currentAssetId !== assetId) return; // user moved on
      const status = (err as { status?: number } | null)?.status;
      const url = (err as { url?: string } | null)?.url;
      console.error('[image-canvas] bytesForAsset failed:', { status, url, err });
      host.byteLoadError.set({ id: assetId, filename });
    });
}
