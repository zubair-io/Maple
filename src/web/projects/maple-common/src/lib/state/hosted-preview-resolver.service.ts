// HostedPreviewResolver — Hosted-mode (File System Access API) counterpart
// to the Self-Hosted `LibrarySource.previewBlob` network call: the real
// embedded-preview-extraction path #2010 adds, replacing the old
// canvas-resize-of-a-full-develop placeholder `LibraryCache.subscribePreviewUrl`
// used to fall back to for Hosted mode.
//
// Extracted out of `LibraryCache` (rather than living there as a private
// method) purely to stay under this repo's file-size budget
// (`tools/check-file-budget.sh`) — `LibraryCache` is already large and this
// is a self-contained concern, the same reasoning `BlobUrlChannel` was
// already extracted for. `bytesForAsset` is passed in as a callback rather
// than injected, since it's `LibraryCache`'s own byte-cache/dedup logic and
// injecting `LibraryCache` here would be circular (`LibraryCache` is this
// resolver's caller).

import { Injectable, inject } from '@angular/core';
import type { Asset, AssetId } from '../models/asset';
import type { MapleAddress } from '../addressing/maple-address';
import { FsAccessLibrarySource } from '../addressing/fs-access-library-source';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { EmbeddedPreviewService } from '../raw-pipeline/embedded-preview.service';
import { isSupportedRaw } from './raw-extensions';
import { LibraryStore } from './library-store.service';

@Injectable({ providedIn: 'root' })
export class HostedPreviewResolver {
  private readonly store = inject(LibraryStore);
  private readonly fsAccessSource = inject(FsAccessLibrarySource);
  private readonly cache = inject(MapleCacheService);
  private readonly previewExtractor = inject(EmbeddedPreviewService);

  /**
   * Resolve the best available embedded-RAW-preview blob for `id`/`address`,
   * or `null` on any miss (non-RAW asset, extraction failure, no embedded
   * preview in this RAW — see the module doc's derivation-parity guarantee).
   * A `null` return is never a hard failure to the caller — `LibraryCache`'s
   * stacked `thumbUrl` stays the shown image either way.
   *
   * Cache key is the asset's `maple_id` (`FsAccessLibrarySource.mapleId`),
   * content-addressed rather than filename-sha-keyed like thumbs — see
   * `MapleCacheService.readPreview`'s doc for why. `mapleId()` itself is
   * IndexedDB-cached (`HostedMapleIdService`/`MapleIdCacheService`, #1995),
   * so a warm folder revisit resolves the cache key without re-reading or
   * re-hashing the file — only a genuine cache MISS falls through to
   * `getBytes` (a real file read) and the WASM extraction.
   *
   * The write-through cache uses `LibraryStore.currentFolder()` — the same
   * already-permission-checked handle `LibraryCache._loadHostedThumb` uses
   * — deliberately NOT `FsAccessLibrarySource`'s own handle resolution
   * (which only ever grants itself read access; see that class's
   * `thumbBlob` comment). Absent (e.g. a direct deep-link before any folder
   * listing populated it) ⇒ extraction still runs and returns a blob, it
   * just isn't persisted — a performance-only miss, not a correctness one,
   * matching `_loadHostedThumb`'s identical `folder?.write` guard.
   *
   * `getBytes` is `LibraryCache.bytesForAsset` — only called on a genuine
   * cache miss, never for a cache hit.
   */
  async resolve(
    id: AssetId,
    address: MapleAddress,
    getBytes: (id: AssetId) => Promise<Uint8Array>,
  ): Promise<Blob | null> {
    const asset: Asset | undefined = this.store.findAsset(id);
    if (!asset || !isSupportedRaw(asset.filename)) {
      // No embedded-preview concept for a non-RAW still (already
      // display-ready pixels) or an asset the store doesn't know about —
      // previewer.ts's own server-side split treats non-RAW separately too.
      return null;
    }

    const ext = asset.filename.split('.').pop()?.toLowerCase() ?? '';

    let mapleId: string;
    try {
      mapleId = await this.fsAccessSource.mapleId(address);
    } catch (err) {
      console.warn('[state] mapleId failed for preview cache key', asset.filename, err);
      return null;
    }

    const folder = this.store.currentFolder();
    if (folder) {
      const cached = await this.cache.readPreview(folder, mapleId);
      if (cached) return cached;
    }

    try {
      const bytes = await getBytes(id);
      const { blob } = await this.previewExtractor.extractEmbeddedPreview(bytes, ext);
      if (folder?.write) {
        void this.cache.writePreview(folder, mapleId, blob);
      }
      return blob;
    } catch (err) {
      // Includes the "no embedded preview in this RAW" case (rare — see
      // `raw_core::preview`'s module doc).
      console.warn('[state] embedded preview extraction failed for', asset.filename, err);
      return null;
    }
  }
}
