// library-store-dimensions.ts — batches `LibraryStore.updateAssetDimensions`
// corrections behind one `assets.update()` per animation frame (#2521).
//
// Extracted out of library-store.service.ts to keep that file under the
// file-size budget headroom (tools/check-budget-headroom.sh, #2311's "split
// with real margin") — this is a self-contained concern (coalesce N pending
// corrections into one array rebuild) that only needs the `assets` signal,
// so it reads cleanly as a small class rather than inline state on the
// service.
//
// Why batching matters: the Hosted browse grid's thumbnail decode calls
// `updateAssetDimensions` once per thumbnail as each one finishes decoding
// (Hosted has no server-side indexer to pre-supply width/height the way
// Self-Hosted does, so every thumbnail's real dimensions are only known
// after decode). Each call used to run its own `assets.update()` — a new
// array over the whole library, changing that one asset's `aspectRatio` —
// which invalidates `assetsInSelectedFolder()` and makes
// `AssetGridComponent` re-pack every row in the folder and cdk-virtual-scroll
// re-render. On an n-thumbnail folder that is a full grid re-pack n times
// instead of once. The editor's single-shot callers (`image-canvas.render2d`,
// `image-canvas.gpu-present`, updating the just-opened asset's real
// dimensions after decode) go through the same batcher; a lone correction
// still lands within one animation frame, so nothing there changes visibly.

import { WritableSignal } from '@angular/core';
import { Asset, AssetId } from '../models/asset';

interface Dimensions {
  width: number;
  height: number;
}

/** Coalesces `updateAssetDimensions` calls into one `assets.update()` per
 * animation frame. Multiple corrections for the same id before the frame
 * fires collapse to the latest one (last write wins, same as calling the
 * unbatched version repeatedly would). */
export class AssetDimensionBatcher {
  private readonly pending = new Map<AssetId, Dimensions>();
  private frameHandle: number | null = null;

  constructor(private readonly assets: WritableSignal<Asset[]>) {}

  update(id: AssetId, width: number, height: number): void {
    this.pending.set(id, { width, height });
    if (this.frameHandle !== null) return;
    this.frameHandle = requestAnimationFrame(() => this.flush());
  }

  /** Applies every pending correction in one array rebuild. Exposed for
   * tests that need a corrected asset to be visible without waiting a real
   * animation frame; production code never calls this directly. */
  flush(): void {
    this.frameHandle = null;
    if (this.pending.size === 0) return;
    // Snapshot, not alias: `this.pending.clear()` must not also empty
    // `corrections` out from under the `assets.update()` callback below.
    const corrections = new Map(this.pending);
    this.pending.clear();
    this.assets.update((list) =>
      list.map((asset) => {
        const dimensions = corrections.get(asset.id);
        if (!dimensions) return asset;
        return { ...asset, ...dimensions, aspectRatio: dimensions.width / dimensions.height };
      }),
    );
  }
}
