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

/**
 * Pipeline version the Hosted thumb cache was developed at (#1927). Unlike
 * Apple's 256-px thumbnails (embedded-JPEG extraction, pipeline-independent),
 * a Hosted thumb is a full WASM develop through the raw-core/AgX chain
 * (`RawPipelineService.decode` with no XMP), so a raw-core/view-transform
 * change alters its pixels. When such a change lands, the develop pipeline's
 * output version is bumped and previously-cached Hosted thumbs re-develop
 * instead of serving stale.
 *
 * Sourced from the single, codegen-generated `PIPELINE_OUTPUT_VERSION` (#1926)
 * — the one monotonic develop-pipeline-output version single-sourced in
 * raw-core and mirrored into TypeScript and Swift. This replaces the
 * hand-maintained per-cache integer this used to be: a raw-core author now
 * bumps one constant and both this thumb cache and Apple's rendered-preview
 * cache (`RenderedPreviewCache`) invalidate together. See
 * `docs/pipeline-output-version.md`.
 */
export const THUMB_PIPELINE_VERSION = PIPELINE_OUTPUT_VERSION;

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

  /**
   * Read a cached thumbnail blob.
   * `sha` is the 16-char hex prefix (sha256Prefix16(filename)).
   * Returns null if not cached — or if a Hosted-written thumb is stale.
   *
   * Pipeline-version guard (#1927): a thumb this client developed carries a
   * `<sha>.<ext>.v` companion recording `THUMB_PIPELINE_VERSION`. When that
   * marker is older than the current version the cached pixels predate a
   * raw-core/AgX change, so we miss and force a re-decode. A thumb with NO
   * marker is foreign — written by the server or native app, which extract
   * the embedded preview (pipeline-version-independent) — and is trusted
   * as-is, preserving the portable `.maple/thumbs/<sha>.<ext>` cross-platform
   * contract. The `.<ext>.v` companion mirrors the API's `<thumb>.meta`
   * sidecar pattern (`routes/fs-thumbs.ts`).
   */
  async readThumb(folder: MapleFolderHandle, sha: string): Promise<Blob | null> {
    for (const { ext, mime } of MapleCacheService.THUMB_READ_ORDER) {
      let bytes: Uint8Array;
      try {
        bytes = await this.fs.readFile(folder, `.maple/thumbs/${sha}.${ext}`);
      } catch {
        continue; // not cached in this format — try the next
      }
      const markerVersion = await this._readThumbVersion(folder, sha, ext);
      if (markerVersion !== null && markerVersion < THUMB_PIPELINE_VERSION) {
        return null; // stale locally-developed thumb → re-decode
      }
      const format: ThumbFormat = ext === 'avif' ? 'avif' : 'jpeg';
      if (!hasCacheImageSignature(bytes, format)) {
        if (markerVersion !== null) return null;
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
   * Write a thumbnail blob plus its pipeline-version companion (#1927).
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
      await this.fs.writeFile(folder, `.maple/thumbs/${sha}.${ext}`, bytes);
      // Stamp the pipeline version this thumb was developed at so a later
      // raw-core/AgX bump invalidates it on read (see readThumb).
      await this.fs.writeFile(
        folder,
        `.maple/thumbs/${sha}.${ext}.v`,
        new TextEncoder().encode(String(THUMB_PIPELINE_VERSION)),
      );
    } catch (err) {
      console.warn(`MapleCacheService: failed to write thumb ${sha}`, err);
    }
  }

  /**
   * Read the pipeline-version marker for a cached thumb at the given
   * extension.
   *   - `null`  — marker ABSENT (a foreign/embedded thumb; `readThumb` trusts it).
   *   - `N`     — the parsed version.
   *   - `-1`    — marker PRESENT but unparseable (e.g. a partial write). A
   *               corrupt marker belongs to a locally-developed thumb whose
   *               version stamp is broken, so force a re-decode rather than
   *               trust it: -1 is always below `THUMB_PIPELINE_VERSION`.
   */
  private async _readThumbVersion(
    folder: MapleFolderHandle,
    sha: string,
    ext: string,
  ): Promise<number | null> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fs.readFile(folder, `.maple/thumbs/${sha}.${ext}.v`);
    } catch {
      return null; // absent → foreign thumb, trust
    }
    const parsed = Number.parseInt(new TextDecoder().decode(bytes).trim(), 10);
    return Number.isFinite(parsed) ? parsed : -1;
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
        return await this._readLegacyAvifPreview(folder, relDir, filename, source);
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

  private async _readLegacyAvifPreview(
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
