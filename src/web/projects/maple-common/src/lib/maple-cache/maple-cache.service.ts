// MapleCacheService — read/write the .maple/ folder cache protocol.
//
// Spec § 03 rules enforced here:
//   - Never writes to source files.
//   - Thumbs keyed by sha256(filename)[:16], not by asset id.
//   - index.json is cache-only; never treat it as authoritative.
//   - Gracefully degrades: all read/write errors are swallowed and logged.

import { Injectable, inject } from '@angular/core';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { MapleFolderHandle } from '../folder-access/folder-access.types';
import { MapleIndex, IndexedAsset } from './maple-cache.types';
import { PIPELINE_OUTPUT_VERSION } from '../generated/adjustment-model.generated';
import { ThumbFormat } from '../raw-pipeline/image-utils';
import {
  hasCacheImageSignature,
  PREVIEW_CACHE_FORMATS,
  previewFormatForMime,
} from './cache-image-format';
import {
  parsePreviewDescriptor,
  previewArtifactPath,
  previewCacheDir,
  previewDescriptorPath,
  previewIdentityPath,
  samePreviewSource,
  validPreviewSource,
  type PreviewCacheDescriptor,
  type PreviewSourceIdentity,
} from './preview-cache-protocol';

export type { PreviewSourceIdentity } from './preview-cache-protocol';

@Injectable({ providedIn: 'root' })
export class MapleCacheService {
  private fs = inject(FolderAccessService);

  // ── index.json ─────────────────────────────────────────────────────────────

  /**
   * Read `.maple/index.json` from the folder.
   * Returns null if absent, malformed, or unreadable.
   * IMPORTANT: the index is a cache — callers must not treat it as authoritative.
   */
  async readIndex(folder: MapleFolderHandle): Promise<MapleIndex | null> {
    try {
      const bytes = await this.fs.readFile(folder, '.maple/index.json');
      const text = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(text) as MapleIndex;
      if (parsed.version !== '1.0' || !Array.isArray(parsed.assets)) {
        console.warn('MapleCacheService: index.json is not version 1.0 — ignoring');
        return null;
      }
      return parsed;
    } catch {
      // File absent or unreadable — normal on first open.
      return null;
    }
  }

  /**
   * Write `.maple/index.json`.
   * Silently skips if the folder is read-only.
   */
  async writeIndex(folder: MapleFolderHandle, index: MapleIndex): Promise<void> {
    if (!folder.write) return;
    try {
      const json = JSON.stringify(index, null, 2);
      const bytes = new TextEncoder().encode(json);
      await this.fs.ensureSubdirectory(folder, '.maple');
      await this.fs.writeFile(folder, '.maple/index.json', bytes);
    } catch (err) {
      console.warn('MapleCacheService: failed to write index.json', err);
    }
  }

  /** Build an `IndexedAsset` record from an existing one, merging new fields. */
  patchAssetInIndex(
    index: MapleIndex,
    patch: Partial<IndexedAsset> & Pick<IndexedAsset, 'filename'>,
  ): MapleIndex {
    const existing = index.assets.find((a) => a.filename === patch.filename);
    if (existing) {
      const updated = { ...existing, ...patch };
      return {
        ...index,
        assets: index.assets.map((a) => (a.filename === patch.filename ? updated : a)),
        generated: new Date().toISOString(),
      };
    }
    return {
      ...index,
      assets: [...index.assets, patch as IndexedAsset],
      generated: new Date().toISOString(),
    };
  }

  /** Create an empty index structure. */
  emptyIndex(): MapleIndex {
    return {
      version: '1.0',
      generated: new Date().toISOString(),
      generator: 'maple-syrup',
      assets: [],
    };
  }

  // ── Thumbnails ─────────────────────────────────────────────────────────────

  /** Read order for `readThumb`: AVIF is the current format everywhere
   * (server, native app, and this client's own local-decode fallback);
   * `.jpg` is probed second to cover pre-existing cached entries and any
   * browser whose local encode fell back to JPEG (see `canvasToBlob`). */
  private static readonly THUMB_READ_ORDER: ReadonlyArray<{ ext: string; mime: string }> = [
    { ext: 'avif', mime: 'image/avif' },
    { ext: 'jpg', mime: 'image/jpeg' },
  ];

  async readThumb(folder: MapleFolderHandle, sha: string): Promise<Blob | null> {
    for (const { ext, mime } of MapleCacheService.THUMB_READ_ORDER) {
      let bytes: Uint8Array;
      try {
        bytes = await this.fs.readFile(
          folder,
          `.maple/thumbs/${sha}.v${PIPELINE_OUTPUT_VERSION}.${ext}`,
        );
      } catch {
        continue; // not cached in this format — try the next
      }
      const format: ThumbFormat = ext === 'avif' ? 'avif' : 'jpeg';
      if (!hasCacheImageSignature(bytes, format)) {
        continue; // corrupt or mislabeled entry — try the other real format
      }
      // Copy into a fresh plain ArrayBuffer (readFile returns Uint8Array whose
      // .buffer may be typed as ArrayBufferLike; Blob requires ArrayBuffer).
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      return new Blob([ab], { type: mime });
    }
    return null;
  }

  /**
   * Write a thumbnail blob under the current pipeline version.
   * Creates `.maple/thumbs/` if necessary.
   * Silently skips if the folder is read-only.
   *
   * `format` defaults to `'jpeg'` for back-compat with any caller that
   * doesn't pass one — the real callers (`library-cache.service.ts`) always
   * pass the format `canvasToBlob` actually produced.
   */
  async writeThumb(
    folder: MapleFolderHandle,
    sha: string,
    blob: Blob,
    format: ThumbFormat = 'jpeg',
  ): Promise<void> {
    if (!folder.write) return;
    const ext = format === 'avif' ? 'avif' : 'jpg';
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!hasCacheImageSignature(bytes, format)) {
        console.warn(`MapleCacheService: refused mislabeled ${format} thumb ${sha}`);
        return;
      }
      await this.fs.ensureSubdirectory(folder, '.maple/thumbs');
      await this.fs.writeFile(
        folder,
        `.maple/thumbs/${sha}.v${PIPELINE_OUTPUT_VERSION}.${ext}`,
        bytes,
      );
    } catch (err) {
      console.warn(`MapleCacheService: failed to write thumb ${sha}`, err);
    }
  }

  // ── Previews (unedited embedded-RAW-preview tier, #2010 / epic #1993) ──────

  /** Read a Hosted-private preview descriptor and its declared artifact.
   * New entries may be AVIF, JPEG, WebP, or PNG, but the descriptor's closed
   * format/MIME mapping, source identity, and byte signature must all agree.
   * A present malformed descriptor fails closed. When no descriptor exists,
   * the legacy cross-platform `<filename>.avif` contract remains readable. */
  async readPreview(
    folder: MapleFolderHandle,
    relDir: string,
    filename: string,
    source: PreviewSourceIdentity,
  ): Promise<Blob | null> {
    try {
      const descriptor = await this._readPreviewDescriptor(folder, relDir, filename);
      if (descriptor === 'absent') {
        return await this._readCanonicalAvifPreview(folder, relDir, filename, source);
      }
      if (!descriptor || !samePreviewSource(descriptor.source, source)) return null;

      // Apple and the Self-Hosted API intentionally keep writing the portable
      // fixed-name AVIF without this Hosted-only descriptor. Do not let an
      // older local JPEG/WebP/PNG descriptor permanently shadow a newer
      // cross-platform develop. This adds one metadata lookup only for the
      // browser-native formats; the normal artifact read remains unchanged.
      if (descriptor.format !== 'avif') {
        const canonical = await this._readNewerCanonicalAvif(
          folder,
          relDir,
          filename,
          descriptor.artifactLastModified,
        );
        if (canonical) return canonical;
      }

      const bytes = await this.fs.readFile(
        folder,
        previewArtifactPath(relDir, filename, descriptor.format),
      );
      if (!hasCacheImageSignature(bytes, descriptor.format)) return null;
      return new Blob([bytes as unknown as BlobPart], { type: descriptor.mimeType });
    } catch {
      return null;
    }
  }

  /** Write the browser's actual encoded format, then publish its descriptor.
   * The artifact is written first so a partial first write cannot advertise
   * missing bytes. Unknown MIME types and mismatched signatures are refused. */
  async writePreview(
    folder: MapleFolderHandle,
    relDir: string,
    filename: string,
    blob: Blob,
    source: PreviewSourceIdentity,
  ): Promise<void> {
    if (!folder.write) return;
    try {
      const format = previewFormatForMime(blob.type);
      if (!format || !validPreviewSource(source)) {
        console.warn(`MapleCacheService: refused invalid preview ${relDir}/${filename}`);
        return;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!hasCacheImageSignature(bytes, format)) {
        console.warn(
          `MapleCacheService: refused mislabeled ${format} preview ${relDir}/${filename}`,
        );
        return;
      }
      await this.fs.ensureSubdirectory(folder, previewCacheDir(relDir));
      const artifactPath = previewArtifactPath(relDir, filename, format);
      await this.fs.writeFile(folder, artifactPath, bytes);
      const artifactLastModified = (await this.fs.fileMetadata(folder, artifactPath)).lastModified;
      const descriptor: PreviewCacheDescriptor = {
        version: 1,
        format,
        mimeType: PREVIEW_CACHE_FORMATS[format].mimeType,
        source,
        artifactLastModified,
      };
      await this.fs.writeFile(
        folder,
        previewDescriptorPath(relDir, filename),
        new TextEncoder().encode(JSON.stringify(descriptor)),
      );
    } catch (err) {
      console.warn(`MapleCacheService: failed to write preview ${relDir}/${filename}`, err);
    }
  }

  private async _readPreviewDescriptor(
    folder: MapleFolderHandle,
    relDir: string,
    filename: string,
  ): Promise<PreviewCacheDescriptor | 'absent' | null> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fs.readFile(folder, previewDescriptorPath(relDir, filename));
    } catch {
      return 'absent';
    }
    return parsePreviewDescriptor(bytes);
  }

  private async _readCanonicalAvifPreview(
    folder: MapleFolderHandle,
    relDir: string,
    filename: string,
    source: PreviewSourceIdentity,
  ): Promise<Blob | null> {
    const path = previewArtifactPath(relDir, filename, 'avif');
    const bytes = await this.fs.readFile(folder, path);
    if (!hasCacheImageSignature(bytes, 'avif')) return null;

    let matches: boolean;
    try {
      const identityBytes = await this.fs.readFile(folder, previewIdentityPath(relDir, filename));
      try {
        const recorded = JSON.parse(
          new TextDecoder().decode(identityBytes),
        ) as PreviewSourceIdentity;
        matches = validPreviewSource(recorded) && samePreviewSource(recorded, source);
      } catch {
        return null;
      }
    } catch {
      const metadata = await this.fs.fileMetadata(folder, path);
      matches = metadata.lastModified >= source.lastModified;
    }
    if (!matches) return null;
    return new Blob([bytes as unknown as BlobPart], { type: 'image/avif' });
  }

  private async _readNewerCanonicalAvif(
    folder: MapleFolderHandle,
    relDir: string,
    filename: string,
    describedArtifactMtime: number,
  ): Promise<Blob | null> {
    const path = previewArtifactPath(relDir, filename, 'avif');
    let canonicalMtime: number;
    try {
      canonicalMtime = (await this.fs.fileMetadata(folder, path)).lastModified;
    } catch {
      return null;
    }
    if (canonicalMtime <= describedArtifactMtime) return null;

    try {
      const bytes = await this.fs.readFile(folder, path);
      if (!hasCacheImageSignature(bytes, 'avif')) return null;
      return new Blob([bytes as unknown as BlobPart], { type: 'image/avif' });
    } catch {
      return null;
    }
  }
}
