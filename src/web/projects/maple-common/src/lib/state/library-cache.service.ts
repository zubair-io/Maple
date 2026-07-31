// Library cache — LRU of raw RAW bytes + thumbnail blob URLs.
// All on-demand reads funnel through here so callers can `await` without
// re-implementing dedup, eviction, or backend branching.

import { Injectable, inject, signal, effect } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Asset, AssetId } from '../models/asset';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService, type DownloadProgress } from '../api/filesystem-browse.service';
import { FolderEntry, MapleFolderHandle } from '../folder-access/folder-access.types';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { imageDataToBitmap, resizeBitmapToCanvas, canvasToBlob } from '../raw-pipeline/image-utils';
import { sha256Prefix16 } from '../maple-cache/sha';
import { LibraryStore } from './library-store.service';
import { LibrarySelection } from './library-selection.service';
import { LIBRARY_SOURCE, type LibrarySource } from '../addressing/library-source';
import { parseAddress } from '../addressing/maple-address';
import { BlobUrlChannel } from './blob-url-channel';
import { LruCache, ThumbLruCache } from './lru-cache';
import { HostedPreviewResolver } from './hosted-preview-resolver.service';
import { isM2Asset, readAssetBytes } from './library-cache.byte-source';

@Injectable({ providedIn: 'root' })
export class LibraryCache {
  private readonly store = inject(LibraryStore);
  private readonly selection = inject(LibrarySelection);
  private readonly api = inject(BunApiBackendService);
  private readonly fsBrowse = inject(FilesystemBrowseService);
  private readonly librarySource: LibrarySource = inject(LIBRARY_SOURCE);
  private readonly cache = inject(MapleCacheService);
  private readonly pipeline = inject(RawPipelineService);
  private readonly hostedPreview = inject(HostedPreviewResolver);

  private _lastSelectedSourceId = this.selection.selectedSourceId();

  constructor() {
    effect(() => {
      const current = this.selection.selectedSourceId();
      if (current !== this._lastSelectedSourceId) {
        this._lastSelectedSourceId = current;
        this._clearQueue();
      }
    });
  }

  /**
   * LRU cache: at most 1 GB of RAW bytes resident in memory.
   * Configurable but 1 GB is a safe default for the browse view.
   */
  private readonly byteCache = new LruCache(1024 * 1024 * 1024);

  /**
   * Map from AssetId to the FolderEntry (file handle) for on-demand reads.
   * Populated by openFolder(); also populated for imported files.
   */
  readonly fileHandles = new Map<AssetId, FolderEntry>();

  /**
   * For legacy in-memory imports (drag-drop, <input> picker without FS Access),
   * bytes are stored here and don't go through the file handle path.
   * These are still bounded by LRU; we just pre-populate the cache entry.
   */
  private readonly legacyBytes = new Map<AssetId, Uint8Array>();

  /** In-flight byte reads (deduplication). */
  private readonly byteReads = new Map<AssetId, Promise<Uint8Array>>();

  // ── Open download progress ───────────────────────────────────────────────

  /**
   * Determinate download progress for the asset currently being opened in
   * the editor, or `null` when nothing is downloading from the network.
   *
   * Only set for genuine network reads (the Self-Hosted `/api/image/:slug/*` and
   * `/api/assets/:id/raw` paths). LRU hits, legacy in-memory imports, and the
   * Hosted FS-Access file-handle path never touch the network, so they leave
   * this `null` and the editor shows no bar.
   *
   * Keyed by `assetId` so a fast A→B asset switch can't paint A's progress on
   * B — the editor matches `id` against its focused asset. A short delay
   * (see {@link OPEN_PROGRESS_DELAY_MS}) keeps fast/LAN opens from flashing a
   * bar that would vanish a frame later.
   */
  readonly openDownloadProgress = signal<{
    id: AssetId;
    loaded: number;
    total: number | null;
  } | null>(null);

  /**
   * Delay before the progress bar is allowed to appear. If the bytes land
   * before this fires, no bar ever renders — instant/cached/LAN opens stay
   * flash-free. Determinate from the first painted frame because we carry the
   * known size through as `total`.
   */
  private static readonly OPEN_PROGRESS_DELAY_MS = 120;

  // ── Thumbnails ─────────────────────────────────────────────────────────────

  /**
   * Subscriber/LRU/in-flight-load channel backing thumbnail URLs. Capacity:
   * 500 entries — at 10-30 kB each, comfortable even for a 5,000-image
   * folder. Entries evict (and revoke) as new thumbnails arrive, self-trimming
   * across folder navigation instead of needing a full wipe (M2, #1327).
   *
   * The reactive SIGNAL for a subscribed id lives in the tile component
   * (asset-thumb / library-cell), so the live-subscriber count tracks the
   * *rendered* tiles and can't accumulate orphans — the leak in #1363/#1359.
   */
  private readonly thumbChannel = new BlobUrlChannel<AssetId>(500);

  /**
   * Signal view of the thumbnail URL map. Components read this reactively;
   * `cacheThumbnailUrl` keeps it in sync with `thumbChannel` after every mutation.
   */
  readonly thumbnailUrls = signal<Map<AssetId, string>>(new Map());

  /** Test-only reach-through: exposes the channel's per-id subscriber count. */
  private get thumbSubscribers(): { size: number } {
    return { size: this.thumbChannel.subscriberCount };
  }

  /**
   * In-flight `ensureThumbnailUrl` loads, so concurrent grid + filmstrip
   * callers share one request per asset. Separate from `thumbChannel`'s own
   * dedup because `_loadThumbInternal` is a multi-branch loader with an
   * `onThumbWritten` side effect, not `BlobUrlChannel.ensure()`'s simple shape.
   */
  private readonly thumbLoadingTokens = new Map<AssetId, { token: symbol; sourceId: string }>();

  // ── Thumbnail load queue ──────────────────────────────────────────────────
  private static readonly MAX_CONCURRENT_THUMB_LOADS = 4;
  private _inflightThumbLoads = 0;
  private readonly _thumbLoadQueue: Array<{
    asset: Asset;
    sourceId: string;
    onThumbWritten?: (id: AssetId, sha: string) => void;
    resolve: () => void;
    reject: (err: any) => void;
  }> = [];

  /**
   * Subscribe a tile to thumbnail-URL changes for `id`. Invokes `cb` immediately
   * with the current URL, then again whenever it changes (load completes, or
   * the LRU evicts it → `undefined`). Returns an unsubscribe fn; the caller
   * calls it on destroy / asset-input change, bounding the live-subscriber
   * count to the viewport.
   */
  subscribeThumbUrl(id: AssetId, cb: (url: string | undefined) => void): () => void {
    return this.thumbChannel.subscribe(id, cb);
  }

  // ── Preview (best display still) ────────────────────────────────────────────

  /**
   * Subscriber/LRU/in-flight-load channel backing preview (embedded 1280px)
   * blob URLs. Same shape as {@link thumbChannel}, separate keyspace so a
   * preview load never evicts a thumbnail.
   *
   * Capacity: 64 — far lower than the 500-entry thumbnail cap, because
   * preview JPEGs are 1280px stills (hundreds of kB to a few MB each) vs
   * ~10-30 kB thumbnails: 500 resident previews would be a multi-hundred-MB
   * footprint, unacceptable on mobile. 64 keeps a generous window warm instead.
   */
  private readonly previewChannel = new BlobUrlChannel<AssetId>(64);

  /**
   * Subscribe to preview-URL changes for `id` — the best available _still_.
   * Prefers a richer source than the thumbnail when one exists (see
   * {@link _previewLoader}): a Self-Hosted network preview, or a Hosted
   * (FS-Access) embedded-preview extraction cached as canonical
   * `<dir>/.maple/previews/<filename>.avif`. Falls back to
   * {@link subscribeThumbUrl} otherwise.
   */
  subscribePreviewUrl(id: AssetId, cb: (url: string | undefined) => void): () => void {
    const loader = this._previewLoader(id);
    if (!loader) return this.subscribeThumbUrl(id, cb);
    const unsubscribe = this.previewChannel.subscribe(id, cb);
    this.previewChannel.ensure(id, loader);
    return unsubscribe;
  }

  /**
   * The richer-than-thumbnail preview loader for `id`, or `null` when the only
   * source is the stacked thumbnail (a Self-Hosted legacy `fs:` id). Hosted
   * (FS-Access) ids route through {@link HostedPreviewResolver}, which no-ops
   * to `null` for non-RAW assets so the thumbnail stands.
   */
  private _previewLoader(id: AssetId): ((id: AssetId) => Promise<Blob | null>) | null {
    const isAddress = typeof id === 'string' && id.includes(':') && !id.startsWith('fs:');
    if (this.store.backend === 'self-hosted') {
      return isAddress
        ? (assetId) => this.librarySource.previewBlob(parseAddress(assetId as string))
        : null;
    }
    return (assetId) => this.hostedPreview.resolve(assetId, (bid) => this.bytesForAsset(bid));
  }

  // ── Reset ──────────────────────────────────────────────────────────────────

  /** Clear all in-memory state. Called on folder switch. */
  clearAll(): void {
    this.byteCache.clear();
    this.fileHandles.clear();
    this.legacyBytes.clear();
    // Revoke all thumbnail blob URLs and notify subscribers via the channel.
    // Hard-reset path (sign-out / forced wipe); the LRU evicts old entries
    // automatically during normal browsing so most folder switches don't
    // need a full wipe.
    this.thumbChannel.clearAll();
    this.thumbnailUrls.set(new Map());
    // FilesystemBrowseService owns the FS-walk thumb blob URLs in its own cache
    // (unbounded, previously revoked only on sign-out). Clear it here too so a
    // folder switch reclaims that memory instead of letting it accumulate for
    // the whole session.
    this.fsBrowse.clearThumbCache();

    // Reset the thumbnail load queue (leave _inflightThumbLoads alone so it settles naturally)
    this._clearQueue();

    // Preview cache/subscribers: same hard-reset treatment as thumbnails above.
    this.previewChannel.clearAll();
  }

  // ── Direct cache primitives (used by fetch / imports) ─────────────────────

  /** Pre-populate the byte cache with bytes already in hand. */
  primeBytes(id: AssetId, bytes: Uint8Array): void {
    this.legacyBytes.set(id, bytes);
    this.byteCache.set(id, bytes);
  }

  /** Register a folder entry for lazy reads. */
  registerHandle(id: AssetId, entry: FolderEntry): void {
    this.fileHandles.set(id, entry);
  }

  // ── Lazy byte access ───────────────────────────────────────────────────────

  /**
   * Lazily read the raw bytes for an asset.
   * On first call: reads from the file handle (or legacy in-memory store).
   * Subsequent calls: returns the LRU-cached bytes instantly.
   * Concurrent calls for the same id share a single in-flight read.
   */
  async bytesForAsset(id: AssetId): Promise<Uint8Array> {
    // 1. LRU cache hit.
    const cached = this.byteCache.get(id);
    if (cached) return cached;

    // 2. Deduplicate concurrent requests for the same id.
    const inflight = this.byteReads.get(id);
    if (inflight) return inflight;

    const read = this._doReadBytes(id);
    this.byteReads.set(id, read);
    try {
      const bytes = await read;
      this.byteCache.set(id, bytes);
      return bytes;
    } finally {
      this.byteReads.delete(id);
      this._clearProgress(id);
    }
  }

  /**
   * Build the gated `onProgress` callback for a network read of `id`.
   *
   * Always returns a callback (never `undefined`). The callback arms a short
   * timer on its first event; the bar only becomes visible once the timer
   * fires (and only if `id` is still the in-flight read), so fast/LAN opens
   * that resolve before the timer never paint a bar. We carry the known asset
   * size through as `total` so the bar is determinate from the first painted
   * frame.
   */
  private makeProgressCallback(id: AssetId): (p: DownloadProgress) => void {
    const knownSize = this.store.findAsset(id)?.size ?? null;
    let armed = false;
    let visible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: DownloadProgress = { loaded: 0, total: knownSize };

    const publish = () => {
      this.openDownloadProgress.set({
        id,
        loaded: latest.loaded,
        total: latest.total ?? knownSize,
      });
    };

    return (p: DownloadProgress) => {
      latest = { loaded: p.loaded, total: p.total ?? knownSize };
      if (visible) {
        publish();
        return;
      }
      if (!armed) {
        armed = true;
        timer = setTimeout(() => {
          // Only paint if this asset is still the in-flight read.
          if (!this.byteReads.has(id)) return;
          visible = true;
          publish();
        }, LibraryCache.OPEN_PROGRESS_DELAY_MS);
        // Best-effort: stop the timer the moment the read settles.
        void this.byteReads.get(id)?.finally(() => clearTimeout(timer));
      }
    };
  }

  /** Clear the open-progress signal if it's still showing `id`. */
  private _clearProgress(id: AssetId): void {
    if (this.openDownloadProgress()?.id === id) {
      this.openDownloadProgress.set(null);
    }
  }

  // Per-backend byte-read dispatch (legacy in-memory, M2 network — retried on
  // transient failure, #2407 — FS-walk absPath, Self-Hosted apiId, Hosted
  // FS-Access handle) lives in `library-cache.byte-source.ts`, split out to
  // keep this file under the file-size budget.
  private _doReadBytes(id: AssetId): Promise<Uint8Array> {
    return readAssetBytes(id, {
      legacyBytes: this.legacyBytes,
      librarySource: this.librarySource,
      assetAbsPaths: this.store.assetAbsPaths,
      fsBrowse: this.fsBrowse,
      backend: this.store.backend,
      apiAssetIds: this.store.apiAssetIds,
      api: this.api,
      fileHandles: this.fileHandles,
      makeProgressCallback: (assetId) => this.makeProgressCallback(assetId),
    });
  }

  /**
   * Compatibility shim — returns bytes synchronously from in-memory store only.
   * Used by legacy code paths that haven't been converted to the async API yet.
   * Returns undefined for assets that require a disk read.
   */
  bytesFor(id: AssetId): Uint8Array | undefined {
    return this.byteCache.get(id) ?? this.legacyBytes.get(id);
  }

  // ── Thumbnails ─────────────────────────────────────────────────────────────

  cacheThumbnailUrl(id: AssetId, url: string): void {
    // The channel handles LRU insertion + eviction notification + this id's
    // subscriber notification (granular: only tiles showing this id repaint).
    this.thumbChannel.cacheUrl(id, url);
    // Publish a new Map snapshot for `thumbnailUrls()` consumers (the
    // ensureThumbnailUrl short-circuit check). The LRU may have evicted (and
    // revoked) the oldest entry before inserting, so the snapshot stays
    // consistent with the channel.
    this.thumbnailUrls.set(this.thumbChannel.toMap());
  }

  thumbnailUrlFor(id: AssetId): string | undefined {
    // Non-reactive point read of the current URL, for imperative callers. Tiles
    // get reactive updates via `subscribeThumbUrl` (their own component-owned
    // signal), not by reading this inside a computed.
    return this.thumbChannel.get(id);
  }

  /** Idempotently load the blob-URL thumbnail for one asset. Both
   * `<asset-grid>` and `<editor-filmstrip>` call this on every visible row;
   * it short-circuits when the URL is already cached or in flight, so
   * callers can fire it on every change-detection pass without paying for
   * extra network round-trips.
   *
   * Single source of truth for all thumbnail acquisition paths:
   * Swallows errors and logs them — the gradient placeholder stays visible.
   * The entry stays out of `thumbnailUrls`, so a future trigger can retry. */
  ensureThumbnailUrl(asset: Asset, onThumbWritten?: (id: AssetId, sha: string) => void): void {
    if (!asset) return;
    if (this.thumbnailUrls().has(asset.id)) return;
    if (this.thumbLoadingTokens.has(asset.id)) return;

    const token = Symbol('thumb-load');
    const sourceId = this.selection.selectedSourceId();
    this.thumbLoadingTokens.set(asset.id, { token, sourceId });

    void this._ensureThumbnailUrlInternal(asset, onThumbWritten)
      .catch((err) => {
        console.warn('[state] ensureThumbnailUrl failed:', err?.message || err);
      })
      .finally(() => {
        if (this.thumbLoadingTokens.get(asset.id)?.token === token) {
          this.thumbLoadingTokens.delete(asset.id);
        }
      });
  }

  private _clearQueue(): void {
    for (const item of this._thumbLoadQueue) {
      try {
        item.reject(new Error('Queue cleared'));
      } catch (err) {
        // Ignore if already resolved/rejected
      }
    }
    this._thumbLoadQueue.length = 0;
    this.thumbLoadingTokens.clear();
  }

  private _purgeQueueForStaleSource(currentSourceId: string): void {
    // 1. Clear loading tokens for other source IDs
    for (const [assetId, entry] of this.thumbLoadingTokens.entries()) {
      if (entry.sourceId !== currentSourceId) {
        this.thumbLoadingTokens.delete(assetId);
      }
    }

    // 2. Reject and filter queue items that do not match the current source ID
    const toKeep: typeof this._thumbLoadQueue = [];
    for (const item of this._thumbLoadQueue) {
      if (item.sourceId === currentSourceId) {
        toKeep.push(item);
      } else {
        try {
          item.reject(new Error('Queue cleared'));
        } catch (err) {
          // ignore
        }
      }
    }
    this._thumbLoadQueue.length = 0;
    this._thumbLoadQueue.push(...toKeep);
  }

  private async _tryReadCachedThumb(folder: MapleFolderHandle, asset: Asset): Promise<boolean> {
    try {
      const sha = await sha256Prefix16(asset.filename);
      const cached = await this.cache.readThumb(folder, sha);
      if (cached) {
        this.cacheThumbnailUrl(asset.id, URL.createObjectURL(cached));
        return true;
      }
    } catch (err) {
      console.warn('[state] thumb cache read failed for', asset.filename, err);
    }
    return false;
  }

  private async _ensureThumbnailUrlInternal(
    asset: Asset,
    onThumbWritten?: (id: AssetId, sha: string) => void,
  ): Promise<void> {
    // 1. Hosted: try the .maple/thumbs/ on-disk cache first (local IndexedDB lookup, no network).
    if (this.store.backend !== 'self-hosted') {
      const folder = this.store.currentFolder();
      if (folder && (await this._tryReadCachedThumb(folder, asset))) {
        return;
      }
    }

    // 2. Cache miss, or Self-Hosted backend: enqueue for network download/decode.
    await this._enqueueThumbNetworkLoad(asset, onThumbWritten);
  }

  private _enqueueThumbNetworkLoad(
    asset: Asset,
    onThumbWritten?: (id: AssetId, sha: string) => void,
  ): Promise<void> {
    const sourceId = this.selection.selectedSourceId();
    return new Promise<void>((resolve, reject) => {
      this._thumbLoadQueue.push({ asset, sourceId, onThumbWritten, resolve, reject });
      this._processNextThumbLoad();
    });
  }

  private _processNextThumbLoad(): void {
    if (this._inflightThumbLoads >= LibraryCache.MAX_CONCURRENT_THUMB_LOADS) {
      return;
    }
    const next = this._thumbLoadQueue.shift();
    if (!next) {
      return;
    }
    this._inflightThumbLoads++;
    void this._loadThumbInternal(next.asset, next.onThumbWritten)
      .then(next.resolve, next.reject)
      .finally(() => {
        this._inflightThumbLoads--;
        this._processNextThumbLoad();
      });
  }

  private async _loadSelfHostedThumb(asset: Asset): Promise<void> {
    // 0. Self-Hosted M2 slug:relPath asset → /api/thumb via the authed
    //    LibrarySource (HttpClient attaches the bearer).
    if (isM2Asset(asset.id)) {
      const blob = await this.librarySource.thumbBlob(parseAddress(asset.id));
      if (blob) {
        this.cacheThumbnailUrl(asset.id, URL.createObjectURL(blob));
        return;
      }
    }

    // 1. Self-Hosted FS-walk: server renders + caches the JPEG.
    if (asset.absPath) {
      const url = await this.fsBrowse.getThumbBlobUrl(asset.absPath);
      this.cacheThumbnailUrl(asset.id, url);
      return;
    }

    // 2. Self-Hosted Mongo asset (older grid mounts that resolved an apiId).
    const apiId = this.store.apiAssetIds.get(asset.id);
    if (!apiId) return;
    const blob = await firstValueFrom(this.api.getThumb(apiId));
    this.cacheThumbnailUrl(asset.id, URL.createObjectURL(blob));
  }

  private async _loadHostedThumb(
    asset: Asset,
    onThumbWritten?: (id: AssetId, sha: string) => void,
  ): Promise<void> {
    const folder = this.store.currentFolder();
    // Hosted decode fallback: pull bytes, run them through the WASM
    // pipeline, encode to AVIF (falling back to JPEG if the browser can't),
    // store, and write through to the .maple/ cache.
    let bytes: Uint8Array;
    try {
      bytes = await this.bytesForAsset(asset.id);
    } catch {
      return; // mock asset / no source — gradient stays.
    }
    const ext = asset.filename.split('.').pop()?.toLowerCase() ?? '';
    const decoded = await this.pipeline.decode(bytes, ext);
    this.store.updateAssetDimensions(asset.id, decoded.width, decoded.height);
    const bitmap = await imageDataToBitmap(decoded);
    const canvas = await resizeBitmapToCanvas(bitmap, 512);
    bitmap.close();
    const { blob, format } = await canvasToBlob(canvas);
    this.cacheThumbnailUrl(asset.id, URL.createObjectURL(blob));
    if (folder?.write) {
      const sha = await sha256Prefix16(asset.filename);
      void this.cache
        .writeThumb(folder, sha, blob, format)
        .then(() => onThumbWritten?.(asset.id, sha));
    }
  }

  private async _loadThumbInternal(
    asset: Asset,
    onThumbWritten?: (id: AssetId, sha: string) => void,
  ): Promise<void> {
    try {
      if (this.store.backend === 'self-hosted') {
        await this._loadSelfHostedThumb(asset);
      } else {
        await this._loadHostedThumb(asset, onThumbWritten);
      }
    } catch (err) {
      console.warn('[state] thumb load failed for', asset.filename, err);
    }
  }
}
