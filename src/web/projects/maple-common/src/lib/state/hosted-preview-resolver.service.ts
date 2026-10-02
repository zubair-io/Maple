// Hosted-mode counterpart to Self-Hosted LibrarySource.previewBlob. Cold RAW
// caches develop actual XMP and film looks (#3975); absent sidecars retain the
// embedded-preview extraction fast path (#2010).
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
import { HostedRawSidecarService } from './hosted-raw-sidecar.service';
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
  private readonly sidecars = inject(HostedRawSidecarService);

  /**
   * Resolve the best available authored or embedded preview blob for `id`, or `null` on
   * unsupported assets or an embedded-preview miss (see raw_core::preview).
   * Authored-sidecar failures reject, preventing an unedited RAW retry.
   *
   * A present XMP is developed through Rust/WASM with its film LUT. Sidecar
   * read/validation/develop failures reject so thumbnails cannot retry without
   * the authored edits. An absent sidecar retains the embedded JPEG fast path.
   * The returned display blob declares the actual encoded format.
   * A cache write happens as a fire-and-forget side effect on a real miss.
   * Embedded JPEGs are stored directly; developed previews use genuine AVIF
   * or the existing JPEG fallback. A warm revisit reads the declared format
   * through readPreview without developing or extracting again.
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

  /** Snapshot authored XMP and coherent RAW bytes, develop or extract through
   * WASM, then schedule actual-format persistence. Authored failures reject;
   * absent-sidecar extraction failures return null for the normal RAW retry. */
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
    const xml = folder && location ? await this.sidecars.read(folder, location) : null;
    try {
      const snapshot = await this._sourceSnapshot(id, getBytes, sourceBefore, getSourceSnapshot);
      const ext = asset.filename.split('.').pop()?.toLowerCase() ?? '';
      const blob =
        xml !== null
          ? await this.sidecars.develop(snapshot.bytes, ext, xml, folder!, location!)
          : (await this.previewExtractor.extractEmbeddedPreview(snapshot.bytes, ext)).blob;
      this._scheduleWrite(folder, location, blob, snapshot.source, id, getSourceIdentity, xml);
      return blob;
    } catch (err) {
      if (xml !== null) throw err;
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
    xml: string | null,
  ): void {
    if (!folder?.write || !location || !source) return;
    void this._writeWhenCurrent(folder, location, blob, source, id, getSourceIdentity, xml);
  }

  private async _writeWhenCurrent(
    folder: NonNullable<ReturnType<LibraryStore['currentFolder']>>,
    location: PreviewLocation,
    blob: Blob,
    source: PreviewSourceIdentity,
    id: AssetId,
    getSourceIdentity: (id: AssetId) => Promise<PreviewSourceIdentity>,
    xml: string | null,
  ): Promise<void> {
    try {
      if (!samePreviewSource(source, await getSourceIdentity(id))) return;
      if (xml !== (await this.sidecars.read(folder, location))) return;
      await this.cache.writePreview(folder, location.dir, location.filename, blob, source);
    } catch {
      // Cache writes are best-effort and never block the displayed preview.
    }
  }
}
