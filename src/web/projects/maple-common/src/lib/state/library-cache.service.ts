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

import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Asset, AssetId } from '../models/asset';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { FolderEntry } from '../folder-access/folder-access.types';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { imageDataToBitmap, resizeBitmapToCanvas, canvasToBlob } from '../raw-pipeline/image-utils';
import { sha256Prefix16 } from '../maple-cache/sha';
import { LibraryStore } from './library-store.service';

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

@Injectable({ providedIn: 'root' })
export class LibraryCache {
  private readonly store = inject(LibraryStore);
  private readonly api = inject(BunApiBackendService);
  private readonly fsBrowse = inject(FilesystemBrowseService);
  private readonly cache = inject(MapleCacheService);
  private readonly pipeline = inject(RawPipelineService);

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

  // ── Thumbnails ─────────────────────────────────────────────────────────────

  /** Thumbnail URL cache (blob URLs — revoked when assets are removed). */
  readonly thumbnailUrls = signal<Map<AssetId, string>>(new Map());

  /** In-flight thumbnail loads (id → Promise) so concurrent callers from
   * the grid + filmstrip share a single network request per asset. */
  private readonly thumbLoadingIds = new Set<AssetId>();

  // ── Reset ──────────────────────────────────────────────────────────────────

  /** Clear all in-memory state. Called on folder switch. */
  clearAll(): void {
    this.byteCache.clear();
    this.fileHandles.clear();
    this.legacyBytes.clear();
    this.thumbnailUrls.set(new Map());
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
    }
  }

  private async _doReadBytes(id: AssetId): Promise<Uint8Array> {
    // Legacy in-memory path (drag-drop imports without FS Access).
    const legacy = this.legacyBytes.get(id);
    if (legacy) return legacy;

    // Self-Hosted FS-walk path: asset id is `fs:<absPath>` and the bytes
    // come from `/api/fs/raw?path=<abs>`. Checked BEFORE the Mongo-asset
    // path because FS-walk assets aren't in `_apiAssetIds`.
    const fsAbsPath = this.store.assetAbsPaths.get(id);
    if (fsAbsPath) {
      const buf = await this.fsBrowse.getRawBytes(fsAbsPath);
      return new Uint8Array(buf);
    }

    // Self-Hosted: fetch bytes from the Bun API by Mongo asset id.
    if (this.store.backend === 'self-hosted') {
      const apiId = this.store.apiAssetIds.get(id);
      if (!apiId) throw new Error(`bytesForAsset: no api id for asset ${id}`);
      // firstValueFrom: imperative-boundary escape hatch. The LRU cache contract
      // is `Promise<Uint8Array>`; callers `await bytesForAsset(...)`. Keeping the
      // observable flow here would force every caller to resubscribe.
      const buf = await firstValueFrom(this.api.getRawBytes(apiId));
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
    this.thumbnailUrls.update((map) => {
      const next = new Map(map);
      next.set(id, url);
      return next;
    });
  }

  thumbnailUrlFor(id: AssetId): string | undefined {
    return this.thumbnailUrls().get(id);
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
        void this.cache
          .writeThumb(folder, sha, blob)
          .then(() => onThumbWritten?.(asset.id, sha));
      }
    } catch (err) {
      console.warn('[state] thumb load failed for', asset.filename, err);
    }
  }
}
