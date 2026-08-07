// ImageCanvasFilmSync — keeps the GPU live session's loaded film-look LUT in
// sync with the focused asset's `filmLook` adjustment (epic #2683, Task 12).
// Extracted from the component to keep it under the file-size budget, same
// precedent as `image-canvas.gpu-present.ts` / `image-canvas.byteload.ts`.
// `syncIfNeeded` is called from the component's EXISTING model-change effect
// (post cold-open, post `currentBytes` gate) rather than owning a second
// `effect()` of its own — one less reactive subscription to keep in sync
// with the asset-switch / cold-open lifecycle the existing effect already
// handles correctly. `gpuActive` is passed in per-call (not read off a host
// method) for the same reason: the component already computes it for its
// own two-phase scheduler on every tick, so this just reuses that value.
//
// Film only has a GPU live-session code path today (Task 9's routing
// guarantee, `raw-pipeline.decode-route.ts`): the WASM-CPU 2D fast/refine
// phases are SIZED requests, and raw-core has no sized+film-aware render
// entry yet (a documented gap in that file, not this ticket's to close) — so
// this helper is a no-op while the GPU live session isn't active. Export
// (`ImageExportService`) is the OTHER place a `.mlut` gets fetched +
// threaded through, independently of this class.
//
// `RawPipelineService.setFilmLut` transfers its `ArrayBuffer` argument, which
// detaches it — so every post re-fetches from `FilmLutService`. That's cheap:
// its own IDB tier means a repeat fetch for the SAME look never touches the
// network, and IndexedDB's structured-clone `get()` hands back a fresh
// `ArrayBuffer` every time, never the transferred-and-neutered instance.

import type { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import type { LibraryStateService } from '../../state/library-state.service';
import type { FilmLutService } from '../../film/film-lut.service';
import { filmLutKey } from '../../film/film-lut.service';
import type { AssetId } from '../../models/asset';

/** The slice of `ImageCanvasComponent` the film sync reaches back into.
 *  `this` satisfies it structurally — no `implements` needed on the class. */
export interface FilmSyncHost {
  readonly state: LibraryStateService;
  readonly pipeline: RawPipelineService;
  readonly filmLut: FilmLutService;
  /** The asset the canvas is currently presenting (stale-request guard). */
  readonly currentAssetId: AssetId | null;
}

export class ImageCanvasFilmSync {
  /** The (assetId, lookId) pair last successfully posted. Reset on asset
   *  switch (`reset()`) so a fresh session — which always starts with no LUT
   *  loaded — re-posts even a look id it saw on a prior session. */
  private lastPostedAssetId: AssetId | null = null;
  private lastPostedLookId: string | null = null;

  constructor(
    private readonly host: FilmSyncHost,
    /** Force a re-render past `lastRenderedXmp`'s dedup once a look's `.mlut`
     *  has finished loading — the render that dedup-skipped ran before the
     *  worker-side grid arrived, so the canvas needs a nudge once it has. */
    private readonly onLutApplied: () => void,
  ) {}

  /** Call with the CURRENT focused asset id + `filmLook` (+ whether the GPU
   *  live session is the active render path) from inside the component's
   *  model-change effect. No-op off the GPU live path. */
  syncIfNeeded(assetId: AssetId, lookId: string, gpuActive: boolean): void {
    if (!gpuActive) return;
    if (assetId === this.lastPostedAssetId && lookId === this.lastPostedLookId) return;
    void this.sync(assetId, lookId);
  }

  /** Call on asset switch / session teardown — see `lastPostedLookId`'s doc. */
  reset(): void {
    this.lastPostedAssetId = null;
    this.lastPostedLookId = null;
  }

  private async sync(assetId: AssetId, lookId: string): Promise<void> {
    const bytes = lookId ? await this.host.filmLut.getLattice(lookId) : null;
    // Stale guards: the asset may have switched, or the look may have
    // changed again, while the (possibly network) fetch above was pending.
    if (this.host.currentAssetId !== assetId) return;
    if (this.host.state.adjustmentFor(assetId)().filmLook !== lookId) return;
    const payload = bytes ?? new ArrayBuffer(0);
    try {
      await this.host.pipeline.setFilmLut(payload, bytes ? filmLutKey(lookId) : 0);
      this.lastPostedAssetId = assetId;
      this.lastPostedLookId = lookId;
      this.onLutApplied();
    } catch (err) {
      console.warn('[image-canvas] set-film-lut failed:', err);
    }
  }
}
