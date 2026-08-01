// HostedPreviewResolver — Hosted-mode (File System Access API) counterpart to
// the Self-Hosted `LibrarySource.previewBlob` network call: the real
// embedded-preview-extraction path #2010 adds, replacing the old
// canvas-resize-of-a-full-develop placeholder `LibraryCache.subscribePreviewUrl`
// used to fall back to for Hosted mode.
//
// Extracted out of `LibraryCache` (rather than living there as a private
// method) purely to stay under this repo's file-size budget
// (`tools/check-file-budget.sh`) — `LibraryCache` is already ~600 lines and
// this is a self-contained concern, the same reasoning `BlobUrlChannel` was
// already extracted for. `bytesForAsset` is passed in as a callback rather
// than injected, since it is `LibraryCache`'s own byte-cache/dedup logic and
// injecting `LibraryCache` here would be circular (`LibraryCache` is this
// resolver's caller).

import { Injectable, inject } from '@angular/core';
import type { Asset, AssetId } from '../models/asset';
import { MapleCacheService, type PreviewSourceIdentity } from '../maple-cache/maple-cache.service';
import { samePreviewSource } from '../maple-cache/preview-cache-protocol';
import { EmbeddedPreviewService } from '../raw-pipeline/embedded-preview.service';
import { isSupportedRaw } from './raw-extensions';
import { LibraryStore } from './library-store.service';
import type { HostedByteSnapshot } from './hosted-byte-snapshot-cache';
import { previewLocation, type PreviewLocation } from './preview-location';

/** An asset's on-disk location within the granted library folder — the
 * directory (`''` for a root-level file) and basename that key the canonical
 * `<dir>/.maple/previews/<filename>.<actual-format>` cache. `null` when the asset has no
 * addressable folder location (an in-memory drag-drop import), which can be
 * displayed but not persisted. */
@Injectable({ providedIn: 'root' })
export class HostedPreviewResolver {
  private readonly store = inject(LibraryStore);
  private readonly cache = inject(MapleCacheService);
  private readonly previewExtractor = inject(EmbeddedPreviewService);

  /**
   * Resolve the best available unedited-preview blob for `id`, or `null` on
   * any miss (non-RAW asset, extraction failure, or no embedded preview in
   * this RAW — see `raw_core::preview`'s module doc). A `null` return is never
   * a hard failure to the caller — `LibraryCache`'s stacked thumbnail stays the
   * shown image either way.
   *
   * The returned display blob is the extracted preview JPEG (fast, universal).
   * A cache write happens as a fire-and-forget side effect on a real miss.
   * The already extracted JPEG is stored directly under its real format,
   * avoiding a redundant browser transcode. A warm revisit reads that
   * declared artifact via `readPreview` without re-extracting.
   *
   * `getSourceSnapshot` is `LibraryCache.hostedBytesSnapshotFor`, associating
   * cached bytes with the exact File identity on a genuine cache miss.
   * `getBytes` remains the cacheless fallback for isolated/imported callers.
   */
  async resolve(
    id: AssetId,
    getBytes: (id: AssetId) => Promise<Uint8Array>,
    getSourceIdentity: (id: AssetId) => Promise<PreviewSourceIdentity> = async () => ({
      size: 0,
      lastModified: 0,
    }),
    getSourceSnapshot?: (id: AssetId) => Promise<HostedByteSnapshot>,
  ): Promise<Blob | null> {
    const asset = this.store.findAsset(id);
    if (!asset || !isSupportedRaw(asset.filename)) {
      // No embedded-preview concept for a non-RAW still (already display-ready
      // pixels) or an asset the store doesn't know about — the server's
      // previewer.ts splits non-RAW off separately too.
      return null;
    }

    const location = previewLocation(id);
    const folder = this.store.currentFolder();
    let sourceBefore: PreviewSourceIdentity | null = null;

    // Cache read: only possible with both a folder handle AND an addressable
    // on-disk location to key off. Absent either (a direct deep-link before a
    // listing populated the folder, or an in-memory import) ⇒ skip straight to
    // a one-shot extraction — a performance-only miss, not a correctness one.
    if (folder && location) {
      try {
        const source = await getSourceIdentity(id);
        sourceBefore = source;
        const cached = await this.cache.readPreview(
          folder,
          location.dir,
          location.filename,
          source,
        );
        if (cached) return cached;
      } catch {
        // Missing source metadata is a cache miss: correctness beats reusing a
        // derivative whose source identity cannot be established.
      }
    }

    return this._extractAndCache(
      id,
      asset,
      folder,
      location,
      getBytes,
      getSourceIdentity,
      sourceBefore,
      getSourceSnapshot,
    );
  }

  /** Read a coherent source snapshot, extract via the WASM worker, kick off an
   * actual-format write-through, and return the display JPEG. `null` on any
   * failure (logged), including a RAW without an embedded preview. */
  private async _extractAndCache(
    id: AssetId,
    asset: Asset,
    folder: ReturnType<LibraryStore['currentFolder']>,
    location: PreviewLocation | null,
    getBytes: (id: AssetId) => Promise<Uint8Array>,
    getSourceIdentity: (id: AssetId) => Promise<PreviewSourceIdentity>,
    sourceBefore: PreviewSourceIdentity | null,
    getSourceSnapshot?: (id: AssetId) => Promise<HostedByteSnapshot>,
  ): Promise<Blob | null> {
    try {
      const snapshot = await this._sourceSnapshot(id, getBytes, sourceBefore, getSourceSnapshot);
      const ext = asset.filename.split('.').pop()?.toLowerCase() ?? '';
      const { blob } = await this.previewExtractor.extractEmbeddedPreview(snapshot.bytes, ext);
      this._scheduleWrite(folder, location, blob, snapshot.source, id, getSourceIdentity);
      return blob;
    } catch (err) {
      console.warn('[state] embedded preview extraction failed for', asset.filename, err);
      return null;
    }
  }

  private async _sourceSnapshot(
    id: AssetId,
    getBytes: (id: AssetId) => Promise<Uint8Array>,
    source: PreviewSourceIdentity | null,
    getSnapshot?: (id: AssetId) => Promise<HostedByteSnapshot>,
  ): Promise<{ bytes: Uint8Array; source: PreviewSourceIdentity | null }> {
    if (getSnapshot) return getSnapshot(id);
    return { bytes: await getBytes(id), source };
  }

  private _scheduleWrite(
    folder: ReturnType<LibraryStore['currentFolder']>,
    location: PreviewLocation | null,
    blob: Blob,
    source: PreviewSourceIdentity | null,
    id: AssetId,
    getSourceIdentity: (id: AssetId) => Promise<PreviewSourceIdentity>,
  ): void {
    if (!folder?.write || !location || !source) return;
    void this._writeWhenCurrent(folder, location, blob, source, id, getSourceIdentity);
  }

  private async _writeWhenCurrent(
    folder: NonNullable<ReturnType<LibraryStore['currentFolder']>>,
    location: PreviewLocation,
    blob: Blob,
    source: PreviewSourceIdentity,
    id: AssetId,
    getSourceIdentity: (id: AssetId) => Promise<PreviewSourceIdentity>,
  ): Promise<void> {
    try {
      if (!samePreviewSource(source, await getSourceIdentity(id))) return;
      await this.cache.writePreview(folder, location.dir, location.filename, blob, source);
    } catch {
      // Cache writes are best-effort and never block the displayed preview.
    }
  }
}
