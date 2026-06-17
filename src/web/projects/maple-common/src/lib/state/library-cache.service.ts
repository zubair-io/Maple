// Library cache — LRU of raw RAW bytes + thumbnail blob URLs.
//
// All on-demand reads funnel through here so callers can `await` without
// re-implementing dedup, eviction, or backend branching. Reads pull from:
//   - the LRU (cache hit, instant)
//   - the legacy in-memory map (drag-drop imports without FS Access)
//   - the Self-Hosted FS-walk path (`/api/fs/raw?path=…`)
//   - the Self-Hosted Mongo asset path (`api.getRawBytes(apiId)`)
//   - the Hosted FS Access folder handle (`entry.getFile()`)
//
// Thumbnails: idempotent loader that fetches once per asset, caches the
// resulting blob URL, and writes through to the `.maple/thumbs/` on-disk
// cache on Hosted.

import { Injectable, WritableSignal, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Asset, AssetId } from '../models/asset';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService, type DownloadProgress } from '../api/filesystem-browse.service';
import { FolderEntry } from '../folder-access/folder-access.types';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { imageDataToBitmap, resizeBitmapToCanvas, canvasToBlob } from '../raw-pipeline/image-utils';
import { sha256Prefix16 } from '../maple-cache/sha';
import { LibraryStore } from './library-store.service';
import { LIBRARY_SOURCE, type LibrarySource } from '../addressing/library-source';
import { parseAddress } from '../addressing/maple-address';

// ── LRU cache ─────────────────────────────────────────────────────────────────

/**
 * Simple LRU cache keyed by AssetId, evicting by total byte count.
 * Uses Map insertion order as a recency queue (delete-and-reinsert on access).
 */
export class LruCache {
  private entries = new Map<AssetId, Uint8Array>();
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(id: AssetId): Uint8Array | undefined {
    const v = this.entries.get(id);
    if (v) {
      // Refresh recency by reinserting at the end.
      this.entries.delete(id);
      this.entries.set(id, v);
    }
    return v;
  }

  set(id: AssetId, bytes: Uint8Array): void {
    if (this.entries.has(id)) {
      this.totalBytes -= this.entries.get(id)!.byteLength;
      this.entries.delete(id);
    }
    this.entries.set(id, bytes);
    this.totalBytes += bytes.byteLength;
    this._evict();
  }

  delete(id: AssetId): void {
    const v = this.entries.get(id);
    if (v) {
      this.totalBytes -= v.byteLength;
      this.entries.delete(id);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private _evict(): void {
    while (this.totalBytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as AssetId;
      const removed = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      this.totalBytes -= removed.byteLength;
    }
  }
}

// ── Thumbnail LRU cache ───────────────────────────────────────────────────────

/**
 * Count-bounded LRU cache for thumbnail URLs (blob: or plain HTTPS strings).
 * Uses Map insertion order as a recency queue (delete-and-reinsert on access).
 * Revokes `blob:` URLs when entries are evicted or the cache is cleared so
 * Blob bytes are freed promptly rather than waiting for a folder switch.
 *
 * Default capacity: 500 thumbnails. At 10-30 kB each this stays well inside
 * a comfortable memory envelope even on a 5,000-image folder. Folder switch
 * used to wipe the entire map; with this LRU, recently-viewed thumbnails from
 * the previous folder stay warm until displaced by newer ones (M2, #1327).
 */
export class ThumbLruCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly maxCount: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(id: string): string | undefined {
    const v = this.entries.get(id);
    if (v !== undefined) {
      // Refresh recency by reinserting at the end.
      this.entries.delete(id);
      this.entries.set(id, v);
    }
    return v;
  }

  set(id: string, url: string, onEvict?: (evictedId: string) => void): void {
    if (this.entries.has(id)) {
      // Revoke the previous blob: URL before replacing so we don't leak
      // the old Blob object — the caller won't hold a reference to it.
      const prev = this.entries.get(id)!;
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
      this.entries.delete(id);
    }
    this.entries.set(id, url);
    this._evict(onEvict);
  }

  /** Revoke all blob URLs and empty the cache. */
  clearAll(): void {
    for (const url of this.entries.values()) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    this.entries.clear();
  }

  /** Snapshot as a plain Map for the Angular signal. */
  toMap(): Map<string, string> {
    return new Map(this.entries);
  }

  private _evict(onEvict?: (evictedId: string) => void): void {
    while (this.entries.size > this.maxCount) {
      const oldest = this.entries.keys().next().value as string;
      const url = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      onEvict?.(oldest);
    }
  }
}

@Injectable({ providedIn: 'root' })
export class LibraryCache {
  private readonly store = inject(LibraryStore);
  private readonly api = inject(BunApiBackendService);
  private readonly fsBrowse = inject(FilesystemBrowseService);
  private readonly cache = inject(MapleCacheService);
  private readonly pipeline = inject(RawPipelineService);
  private readonly librarySource: LibrarySource = inject(LIBRARY_SOURCE);

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
   * Only set for genuine network reads (the Self-Hosted `/api/fs/raw` and
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
   * Bounded LRU backing store for thumbnail URLs.
   * Capacity: 500 entries. Entries are evicted (and blob URLs revoked)
   * as new thumbnails arrive so the cache self-trims across folder
   * navigation instead of needing a full wipe on each switch (M2, #1327).
   */
  private readonly thumbLru = new ThumbLruCache(500);

  /**
   * Signal view of the thumbnail URL map. Components read this reactively;
   * `cacheThumbnailUrl` keeps it in sync with `thumbLru` after every mutation.
   */
  readonly thumbnailUrls = signal<Map<AssetId, string>>(new Map());

  /** In-flight thumbnail loads (id → Promise) so concurrent callers from
   * the grid + filmstrip share a single network request per asset. */
  private readonly thumbLoadingIds = new Set<AssetId>();

  /**
   * Per-asset reactive signals for thumbnail URLs. Lazily created; a tile's
   * `computed()` depends only on its own id's signal, so loading ONE thumbnail
   * recomputes only THAT tile — not every tile on screen (O(N²) avoidance).
   *
   * Lifecycle: signals are set to `undefined` before being removed (on LRU
   * eviction, the cap eviction in `thumbSignalFor`, and `clearAll`), so any
   * computed that still holds the signal object reacts correctly and recreates
   * it (seeded from the LRU) on its next read.
   *
   * Bounded by THUMB_SIGNAL_CAP. The LRU-eviction delete only covers ids that
   * were cached; an id that is rendered but never cached — a thumbnail that
   * fails to load or a tile scrolled past before its load lands — never enters
   * the LRU, so without the cap its signal would leak for the whole session.
   */
  private static readonly THUMB_SIGNAL_CAP = 1000;
  private readonly thumbSignals = new Map<AssetId, WritableSignal<string | undefined>>();

  /**
   * Lazily create (or return existing) the per-asset signal for `id`, refreshing
   * its access recency. Visible tiles call this every change-detection pass, so
   * they stay most-recent; stale orphans (no longer rendered, never cached) sink
   * to the bottom and evict once the map exceeds THUMB_SIGNAL_CAP.
   */
  private thumbSignalFor(id: AssetId): WritableSignal<string | undefined> {
    const existing = this.thumbSignals.get(id);
    if (existing) {
      // Refresh recency — delete + reinsert moves this id to the most-recent
      // position (JS Map preserves insertion order).
      this.thumbSignals.delete(id);
      this.thumbSignals.set(id, existing);
      return existing;
    }
    const s = signal<string | undefined>(this.thumbLru.get(id));
    this.thumbSignals.set(id, s);
    // Evict the least-recently-accessed entries when over the cap. The id just
    // inserted is most-recent, so it is never the one evicted. Set undefined
    // before delete so a computed still holding an evicted signal recomputes and
    // lazily recreates it from the LRU on next read.
    while (this.thumbSignals.size > LibraryCache.THUMB_SIGNAL_CAP) {
      const oldest = this.thumbSignals.keys().next().value as AssetId | undefined;
      if (oldest === undefined) break;
      this.thumbSignals.get(oldest)?.set(undefined);
      this.thumbSignals.delete(oldest);
    }
    return s;
  }

  // ── Reset ──────────────────────────────────────────────────────────────────

  /** Clear all in-memory state. Called on folder switch. */
  clearAll(): void {
    this.byteCache.clear();
    this.fileHandles.clear();
    this.legacyBytes.clear();
    // Revoke all thumbnail blob URLs via the LRU (it guards on `blob:` itself)
    // then reset the signal so components clear their view. This is the
    // hard-reset path (sign-out / forced wipe); the LRU evicts old entries
    // automatically during normal browsing so most folder switches no longer
    // need a full wipe.
    this.thumbLru.clearAll();
    this.thumbnailUrls.set(new Map());
    // Notify then clear the per-asset signal map. Setting each to `undefined`
    // lets components react to the wipe; then clearing the map keeps memory
    // bounded — signals will be recreated lazily if the same id appears again.
    for (const s of this.thumbSignals.values()) s.set(undefined);
    this.thumbSignals.clear();
    // FilesystemBrowseService owns the FS-walk thumb blob URLs in its own cache
    // (unbounded, previously revoked only on sign-out). Clear it here too so a
    // folder switch reclaims that memory instead of letting it accumulate for
    // the whole session.
    this.fsBrowse.clearThumbCache();
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

  private async _doReadBytes(id: AssetId): Promise<Uint8Array> {
    // Legacy in-memory path (drag-drop imports without FS Access).
    const legacy = this.legacyBytes.get(id);
    if (legacy) return legacy;

    // M2 slug:relPath asset → original bytes via the authed LibrarySource.
    // HttpLibrarySource (Self-Hosted) hits GET /api/image with the bearer;
    // FsAccessLibrarySource (Hosted) walks the FileSystemDirectoryHandle.
    // M2 assets are address-keyed with no absPath/apiId/file-handle, so without
    // this branch they fell through to the apiId path and threw `no api id`,
    // leaving the editor unable to open any address-keyed image. Mirrors the M2
    // thumb branch in _loadThumbInternal. Exclude legacy `fs:<absPath>` ids —
    // they also contain ':' but resolve via the assetAbsPaths FS-walk below.
    if (typeof id === 'string' && id.includes(':') && !id.startsWith('fs:')) {
      const blob = await this.librarySource.imageBlob(
        parseAddress(id),
        this.makeProgressCallback(id),
      );
      return new Uint8Array(await blob.arrayBuffer());
    }

    // Self-Hosted FS-walk path: asset id is `fs:<absPath>` and the bytes
    // come from `/api/fs/raw?path=<abs>`. Checked BEFORE the Mongo-asset
    // path because FS-walk assets aren't in `_apiAssetIds`.
    const fsAbsPath = this.store.assetAbsPaths.get(id);
    if (fsAbsPath) {
      const buf = await this.fsBrowse.getRawBytes(fsAbsPath, this.makeProgressCallback(id));
      return new Uint8Array(buf);
    }

    // Self-Hosted: fetch bytes from the Bun API by Mongo asset id.
    if (this.store.backend === 'self-hosted') {
      const apiId = this.store.apiAssetIds.get(id);
      if (!apiId) throw new Error(`bytesForAsset: no api id for asset ${id}`);
      // firstValueFrom: imperative-boundary escape hatch. The LRU cache contract
      // is `Promise<Uint8Array>`; callers `await bytesForAsset(...)`. Keeping the
      // observable flow here would force every caller to resubscribe.
      const buf = await firstValueFrom(this.api.getRawBytes(apiId, this.makeProgressCallback(id)));
      return new Uint8Array(buf);
    }

    // FS Access / fallback handle path.
    const entry = this.fileHandles.get(id);
    if (!entry) throw new Error(`bytesForAsset: no handle for asset ${id}`);
    const file = await entry.getFile();
    return new Uint8Array(await file.arrayBuffer());
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
    // Pass an eviction callback so any LRU-evicted entry's per-asset signal is
    // cleared immediately — a tile holding that computed must not keep showing
    // a stale or revoked blob URL.
    this.thumbLru.set(id, url, (evictedId) => {
      // Delete the signal so the map stays bounded (≤ LRU capacity + visible
      // tiles in flight). The next thumbnailUrlFor call recreates it from
      // scratch, seeded with undefined — which correctly notifies any computed
      // that still holds a reference that the URL is gone.
      const evictedSignal = this.thumbSignals.get(evictedId as AssetId);
      if (evictedSignal) {
        evictedSignal.set(undefined);
        this.thumbSignals.delete(evictedId as AssetId);
      }
    });
    // Publish a new Map snapshot so components that read `thumbnailUrls()`
    // re-render (e.g. ensureThumbnailUrl short-circuit check). The LRU may
    // have evicted the oldest entry (revoking its blob URL) before inserting
    // the new one, so the snapshot is always consistent with the LRU state.
    this.thumbnailUrls.set(this.thumbLru.toMap() as Map<AssetId, string>);
    // Also update the per-asset signal for fine-grained reactivity: only the
    // tile for THIS id recomputes, not every tile on screen.
    this.thumbSignalFor(id).set(url);
  }

  thumbnailUrlFor(id: AssetId): string | undefined {
    // Read THIS id's per-asset signal to establish a granular reactive dependency.
    // A tile's computed() then recomputes only when ITS thumbnail changes, not when
    // any other thumbnail lands — avoiding the O(N²) global-signal fan-out.
    // (The global `thumbnailUrls` signal is still kept in sync for ensureThumbnailUrl's
    // short-circuit check and for clearAll's revoke pass; we just no longer use it here
    // for reactive tracking.)
    this.thumbSignalFor(id)();
    // Return the value via `thumbLru.get()` (NOT the signal value) so the read
    // refreshes LRU recency — otherwise eviction degrades to FIFO and an
    // actively-viewed thumb can be evicted under load (>500 cached). The signal
    // and LRU are kept in lockstep by cacheThumbnailUrl, so both see the same
    // value; the signal read above is purely for reactive tracking.
    return this.thumbLru.get(id);
  }

  /** Idempotently load the blob-URL thumbnail for one asset. Both
   * `<asset-grid>` and `<editor-filmstrip>` call this on every visible row;
   * it short-circuits when the URL is already cached or in flight, so
   * callers can fire it on every change-detection pass without paying for
   * extra network round-trips.
   *
   * Single source of truth for all thumbnail acquisition paths:
   *   - **Self-Hosted FS-walk** (`asset.absPath`) → `/api/fs/thumb` via
   *     `FilesystemBrowseService.getThumbBlobUrl`. Server-rendered, fast.
   *   - **Self-Hosted Mongo asset** (`apiAssetIds` map populated for legacy
   *     callers that came in via `/api/folders/{id}/assets`) → `api.getThumb`.
   *   - **Hosted with FS Access folder** → read `.maple/thumbs/<sha>.jpg`
   *     from disk. Falls back to client-side WASM decode + write-through.
   *
   * Errors are swallowed and logged — the gradient placeholder stays
   * visible. The entry stays out of `thumbnailUrls`, so a future trigger
   * can retry. */
  ensureThumbnailUrl(asset: Asset, onThumbWritten?: (id: AssetId, sha: string) => void): void {
    if (!asset) return;
    if (this.thumbnailUrls().has(asset.id)) return;
    if (this.thumbLoadingIds.has(asset.id)) return;
    this.thumbLoadingIds.add(asset.id);
    void this._loadThumbInternal(asset, onThumbWritten).finally(() =>
      this.thumbLoadingIds.delete(asset.id),
    );
  }

  private async _loadThumbInternal(
    asset: Asset,
    onThumbWritten?: (id: AssetId, sha: string) => void,
  ): Promise<void> {
    try {
      // 0. Self-Hosted M2 slug:relPath asset → /api/thumb via the authed
      //    LibrarySource (HttpClient attaches the bearer). M2 assets are
      //    address-keyed with no absPath/apiId, so without this they fell
      //    through every branch and showed no thumbnail. Exclude legacy
      //    `fs:<absPath>` ids — they also contain ':' but must use the absPath
      //    FS-walk branch below.
      if (
        this.store.backend === 'self-hosted' &&
        typeof asset.id === 'string' &&
        asset.id.includes(':') &&
        !asset.id.startsWith('fs:')
      ) {
        const blob = await this.librarySource.thumbBlob(parseAddress(asset.id));
        if (blob) {
          this.cacheThumbnailUrl(asset.id, URL.createObjectURL(blob));
          return;
        }
        // null = no thumb yet; fall through to the branches below.
      }

      // 1. Self-Hosted FS-walk: server renders + caches the JPEG.
      if (this.store.backend === 'self-hosted' && asset.absPath) {
        const url = await this.fsBrowse.getThumbBlobUrl(asset.absPath, 512);
        this.cacheThumbnailUrl(asset.id, url);
        return;
      }

      // 2. Self-Hosted Mongo asset (older grid mounts that resolved an apiId).
      if (this.store.backend === 'self-hosted') {
        const apiId = this.store.apiAssetIds.get(asset.id);
        if (!apiId) return;
        const blob = await firstValueFrom(this.api.getThumb(apiId));
        this.cacheThumbnailUrl(asset.id, URL.createObjectURL(blob));
        return;
      }

      // 3. Hosted: try the .maple/thumbs/ on-disk cache first.
      const folder = this.store.currentFolder();
      if (folder) {
        const sha = await sha256Prefix16(asset.filename);
        const cached = await this.cache.readThumb(folder, sha);
        if (cached) {
          this.cacheThumbnailUrl(asset.id, URL.createObjectURL(cached));
          return;
        }
      }

      // 4. Hosted decode fallback: pull bytes, run them through the WASM
      //    pipeline, encode to JPEG, store, and write through to the
      //    .maple/ cache so future sessions hit branch 3 instead.
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
      const blob = await canvasToBlob(canvas);
      this.cacheThumbnailUrl(asset.id, URL.createObjectURL(blob));
      if (folder?.write) {
        const sha = await sha256Prefix16(asset.filename);
        void this.cache.writeThumb(folder, sha, blob).then(() => onThumbWritten?.(asset.id, sha));
      }
    } catch (err) {
      console.warn('[state] thumb load failed for', asset.filename, err);
    }
  }
}
