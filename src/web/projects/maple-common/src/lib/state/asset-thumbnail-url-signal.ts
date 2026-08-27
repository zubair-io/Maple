// createAssetThumbnailUrlSignal — the blob-URL loading effect shared by
// `<maple-asset-tile>` (browse grid) and `<maple-asset-thumb>` (editor
// filmstrip). Extracted (MW6, #3047) once the two components stopped
// sharing a single `variant`-branched template but still needed the exact
// same thumbnail-acquisition contract — duplicating this effect verbatim
// between them was a fallow duplication finding waiting to drift the two
// copies apart.
//
// Must be called from within an Angular injection context (a component
// field initializer or constructor, same as any `inject()`-based
// composable) — it calls `inject(LibraryStateService)` and `effect()`
// itself, so the caller doesn't need to.

import { Signal, effect, inject, signal } from '@angular/core';
import { Asset } from '../models/asset';
import { LibraryStateService } from './library-state.service';

/** Returns a signal tracking `asset`'s thumbnail blob URL — `undefined`
 * until it loads (gradient placeholder stays). The returned signal is
 * owned by whichever component called this, created and destroyed WITH
 * that component's own lifetime — so the live-signal count tracks
 * currently-rendered tiles (a virtualized viewport, or the filmstrip's
 * rendered set) and never accumulates orphans. No central signal map to
 * leak (#1363/#1359).
 *
 * Cleanup also drops the asset's *queued* thumbnail load: both the browse
 * grid and the filmstrip destroy tiles continuously as the user scrolls,
 * so without this their requests stayed in the 4-wide queue and the rows
 * actually on screen waited behind hundreds of rows already scrolled past.
 * A load already in flight is left to finish.
 */
export function createAssetThumbnailUrlSignal(asset: Signal<Asset>): Signal<string | undefined> {
  const state = inject(LibraryStateService);
  const thumbUrl = signal<string | undefined>(undefined);

  // Order matters in the cleanup below: unsubscribe FIRST.
  // `cancelQueuedThumbnail` only drops the queued load when no consumer is
  // left watching that id, and this tile must already be out of that count
  // for the check to mean anything. Swapping these two lines makes every
  // cancel a no-op.
  effect((onCleanup) => {
    const currentAsset = asset();
    if (currentAsset) {
      state.ensureThumbnailUrl(currentAsset);
      const unsub = state.subscribeThumbUrl(currentAsset.id, (url) => {
        thumbUrl.set(url);
      });
      onCleanup(() => {
        unsub();
        state.cancelQueuedThumbnail(currentAsset.id);
      });
    }
  });

  return thumbUrl.asReadonly();
}
