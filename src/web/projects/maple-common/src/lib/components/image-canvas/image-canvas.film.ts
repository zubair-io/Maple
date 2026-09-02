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
// `syncIfNeeded`/`sync` drive the GPU live-session code path: a no-op while
// the GPU live session isn't active. `ensureCpuLutResolving`/`cpuLutBytesFor`
// (#3171) are the sibling for the WASM-CPU 2D fast/refine phases, which have
// a sized+film-aware render entry (`render_bytes_sized_with_film`, routed via
// `raw-pipeline.decode-route.ts`'s `sizedFilm` route, #2719) — the primitive
// raw-core/raw-wasm layer supports a loaded look on the sized path exactly
// like it already does for the unsized one (Task 9's
// `render_bytes_with_film`/`'film'` route). `image-canvas.render2d.ts`'s
// `runRender2d` reads the cached bytes via `cpuLutBytesFor` and threads them
// through `RawPipelineService.decode()`'s `filmLut` parameter on every
// fast/refine tick while the GPU live session isn't the active render path.
// Export (`ImageExportService`) is the OTHER place a `.mlut` gets fetched +
// threaded through, independently of this class.
//
// The CPU cache deliberately does NOT reuse `lastPostedAssetId`/
// `lastPostedLookId` — those track what was POSTED to the GPU session (a
// side effect, meaningful even off the CPU path), while the CPU fields track
// what's CACHED and ready to read synchronously from a render tick. The two
// dedup independently so a session can (rarely) flip between GPU and CPU
// paths — a WebGPU adapter failing mid-session — without one path's stale
// dedup state suppressing the other's first sync.
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
    this.cpuLutAssetId = null;
    this.cpuLutLookId = null;
    this.cpuLutBytes = null;
    this.cpuLutFetchKey = null;
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

  // ── WASM-CPU 2D fast/refine path (#3171) ──────────────────────────────
  // `.mlut` bytes resolved for the CURRENTLY cached (assetId, lookId) pair,
  // read synchronously by `image-canvas.render2d.ts`'s `runRender2d` on
  // every render tick. `getLattice` is an async IndexedDB round trip, so a
  // per-tick fetch would blow the slider-tick budget — `ensureCpuLutResolving`
  // kicks off (and dedups) the fetch from the model-change effect instead;
  // `cpuLutBytesFor` only ever reads whatever's already cached, synchronously.
  private cpuLutAssetId: AssetId | null = null;
  private cpuLutLookId: string | null = null;
  private cpuLutBytes: ArrayBuffer | null = null;
  /** The (assetId, lookId) pair a fetch is currently in flight for, so a
   *  second tick before the first fetch resolves doesn't start a duplicate. */
  private cpuLutFetchKey: string | null = null;

  /**
   * Kick off resolving `lookId`'s `.mlut` bytes for the CPU 2D decode path,
   * if the (assetId, lookId) pair isn't already cached or in flight. Call
   * from the model-change effect whenever the GPU live session is NOT the
   * active render path (no WebGPU, kill switch off, or GPU-open fallback).
   * The resolved bytes land in `cpuLutBytesFor` once the fetch settles, and
   * `onLutApplied()` nudges a re-render to pick them up — the same nudge
   * `sync()` already fires for the GPU path.
   */
  ensureCpuLutResolving(assetId: AssetId, lookId: string): void {
    if (!lookId) {
      this.cpuLutAssetId = null;
      this.cpuLutLookId = null;
      this.cpuLutBytes = null;
      return;
    }
    if (assetId === this.cpuLutAssetId && lookId === this.cpuLutLookId) return; // cached
    const key = `${assetId}:${lookId}`;
    if (this.cpuLutFetchKey === key) return; // already in flight
    this.cpuLutFetchKey = key;
    void this.resolveCpuLut(assetId, lookId, key);
  }

  /**
   * The currently-cached `.mlut` bytes for `assetId`/`lookId`, or
   * `undefined` when no look is set or the fetch is still resolving.
   * Synchronous — never triggers a fetch itself; see `ensureCpuLutResolving`.
   */
  cpuLutBytesFor(assetId: AssetId, lookId: string): ArrayBuffer | undefined {
    if (!lookId) return undefined;
    if (assetId !== this.cpuLutAssetId || lookId !== this.cpuLutLookId) return undefined;
    return this.cpuLutBytes ?? undefined;
  }

  /** `cpuLutBytesFor` for the CURRENT focused asset + model, read directly
   *  off `host.currentAssetId`/`host.state` (mirroring `sync()`'s own
   *  reads) so call sites like the component's `runRender` don't have to
   *  re-derive both. `undefined` when there's no focused asset. */
  cpuLutBytesForCurrent(): ArrayBuffer | undefined {
    const assetId = this.host.currentAssetId;
    if (!assetId) return undefined;
    return this.cpuLutBytesFor(assetId, this.host.state.adjustmentFor(assetId)().filmLook);
  }

  private async resolveCpuLut(assetId: AssetId, lookId: string, key: string): Promise<void> {
    const bytes = await this.host.filmLut.getLattice(lookId);
    if (this.cpuLutFetchKey === key) this.cpuLutFetchKey = null;
    // Stale guards, same shape as `sync()`'s: the asset or look may have
    // changed again while the fetch was pending.
    if (this.host.currentAssetId !== assetId) return;
    if (this.host.state.adjustmentFor(assetId)().filmLook !== lookId) return;
    this.cpuLutAssetId = assetId;
    this.cpuLutLookId = lookId;
    // A 404/network failure resolves `null` (never throws — `getLattice`'s
    // own contract); caching it under the (assetId, lookId) key still
    // avoids retrying every tick, and `cpuLutBytesFor` reports "no look" for
    // it exactly like the GPU path's zero-length-buffer clear.
    this.cpuLutBytes = bytes;
    this.onLutApplied();
  }
}
