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
import { ThumbFormat } from '../raw-pipeline/image-utils';
import { sha256Prefix16 } from './sha';
import {
  hasCacheImageSignature,
  PREVIEW_CACHE_FORMATS,
  previewFormatForMime,
} from './cache-image-format';
import {
  LEGACY_DERIVATIVE_SEGMENT,
  parsePreviewDescriptor,
  previewArtifactPath,
  previewCacheDir,
  previewDescriptorPath,
  previewIdentityPath,
  samePreviewSource,
  validPreviewSource,
  type DerivativeNaming,
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

  private static thumbPath(filename: string, ext: string): string {
    return `.maple/thumbs/${filename}.${ext}`;
  }

  private static legacyThumbPath(sha: string, ext: string): string {
    return `.maple/thumbs/${sha}${LEGACY_DERIVATIVE_SEGMENT}.${ext}`;
  }

  /** Read `.maple/thumbs/<filename.ext>.<avif|jpg>`. Thumbs are unversioned
   * and keyed by the photo's own filename (#4793): a pipeline bump never
   * invalidates one. Only when no entry exists under that name is the frozen
   * legacy `<sha256Prefix16(filename)>.v25` name tried, and a hit there is
   * renamed into place rather than regenerated. */
  async readThumb(folder: MapleFolderHandle, filename: string): Promise<Blob | null> {
    const current = await this._readThumbAt(folder, (ext) =>
      MapleCacheService.thumbPath(filename, ext),
    );
    if (current !== 'absent') return current === 'rejected' ? null : current.blob;

    const sha = await sha256Prefix16(filename);
    const legacy = await this._readThumbAt(folder, (ext) =>
      MapleCacheService.legacyThumbPath(sha, ext),
    );
    if (legacy === 'absent' || legacy === 'rejected') return null;
    if (folder.write) {
      await this._moveFiles(folder, [
        {
          from: MapleCacheService.legacyThumbPath(sha, legacy.ext),
          to: MapleCacheService.thumbPath(filename, legacy.ext),
          bytes: async () => legacy.bytes,
        },
      ]);
    }
    return legacy.blob;
  }

  /**
   * Write a thumbnail blob at `.maple/thumbs/<filename.ext>.<avif|jpg>`.
   * Creates `.maple/thumbs/` if necessary.
   * Silently skips if the folder is read-only.
   *
   * `format` defaults to `'jpeg'` for back-compat with any caller that
   * doesn't pass one — the real callers (`library-cache.service.ts`) always
   * pass the format `canvasToBlob` actually produced.
   */
  async writeThumb(
    folder: MapleFolderHandle,
    filename: string,
    blob: Blob,
    format: ThumbFormat = 'jpeg',
  ): Promise<void> {
    if (!folder.write) return;
    const ext = format === 'avif' ? 'avif' : 'jpg';
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!hasCacheImageSignature(bytes, format)) {
        console.warn(`MapleCacheService: refused mislabeled ${format} thumb ${filename}`);
        return;
      }
      await this.fs.ensureSubdirectory(folder, '.maple/thumbs');
      await this.fs.writeFile(folder, MapleCacheService.thumbPath(filename, ext), bytes);
    } catch (err) {
      console.warn(`MapleCacheService: failed to write thumb ${filename}`, err);
    }
  }

  private async _readThumbAt(
    folder: MapleFolderHandle,
    pathFor: (ext: string) => string,
  ): Promise<{ blob: Blob; ext: string; bytes: Uint8Array } | NamedRead> {
    let sawEntry = false;
    for (const { ext, mime } of MapleCacheService.THUMB_READ_ORDER) {
      const bytes = await this._readOptional(folder, pathFor(ext));
      if (bytes === null) continue;
      sawEntry = true;
      // A corrupt or mislabeled entry falls through to the other real format.
      if (!hasCacheImageSignature(bytes, ext === 'avif' ? 'avif' : 'jpeg')) continue;
      return { blob: new Blob([copyToArrayBuffer(bytes)], { type: mime }), ext, bytes };
    }
    return sawEntry ? 'rejected' : 'absent';
  }

  // ── Previews (unedited embedded-RAW-preview tier, #2010 / epic #1993) ──────

  /** Read a Hosted-private preview descriptor and its declared artifact.
   * New entries may be AVIF, JPEG, WebP, or PNG, but the descriptor's closed
   * format/MIME mapping, source identity, and byte signature must all agree.
   * A present malformed descriptor fails closed. When no descriptor exists,
   * the cross-platform `<filename>.avif` contract remains readable. Names are
   * unversioned; the frozen legacy `.v25` names are consulted only when no
   * unversioned descriptor or AVIF exists, and renamed into place on a hit. */
  async readPreview(
    folder: MapleFolderHandle,
    relDir: string,
    filename: string,
    source: PreviewSourceIdentity,
  ): Promise<Blob | null> {
    try {
      return await this._readWithLegacyFallback(folder, (naming) =>
        this._readPreviewNamed(folder, relDir, filename, source, naming),
      );
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
        encodeDescriptor(descriptor),
      );
    } catch (err) {
      console.warn(`MapleCacheService: failed to write preview ${relDir}/${filename}`, err);
    }
  }

  private async _readPreviewNamed(
    folder: MapleFolderHandle,
    relDir: string,
    filename: string,
    source: PreviewSourceIdentity,
    naming: DerivativeNaming,
  ): Promise<CacheHit | NamedRead> {
    const descriptorBytes = await this._readOptional(
      folder,
      previewDescriptorPath(relDir, filename, naming),
    );
    if (descriptorBytes === null) {
      return this._readCanonicalAvifPreview(folder, relDir, filename, source, naming);
    }
    const descriptor = parsePreviewDescriptor(descriptorBytes);
    if (!descriptor || !samePreviewSource(descriptor.source, source)) return 'rejected';

    // Apple and the Self-Hosted API intentionally keep writing the portable
    // fixed-name AVIF without this Hosted-only descriptor. Do not let an
    // older local JPEG/WebP/PNG descriptor permanently shadow a newer
    // cross-platform develop. This adds one metadata lookup only for the
    // browser-native formats; the normal artifact read remains unchanged.
    const canonical =
      descriptor.format === 'avif'
        ? null
        : await this._readNewerCanonicalAvif(
            folder,
            relDir,
            filename,
            naming,
            descriptor.artifactLastModified,
          );
    if (canonical) return canonical;

    const artifactPath = (n: DerivativeNaming) =>
      previewArtifactPath(relDir, filename, descriptor.format, n);
    const bytes = await this.fs.readFile(folder, artifactPath(naming));
    if (!hasCacheImageSignature(bytes, descriptor.format)) return 'rejected';
    return {
      blob: new Blob([bytes as unknown as BlobPart], { type: descriptor.mimeType }),
      files: [
        { path: artifactPath, bytes: async () => bytes },
        {
          path: (n) => previewDescriptorPath(relDir, filename, n),
          // A rename may not preserve mtime, so the moved descriptor is
          // re-stamped against the moved artifact to keep the same precedence.
          bytes: async () =>
            encodeDescriptor({
              ...descriptor,
              artifactLastModified: (await this.fs.fileMetadata(folder, artifactPath('')))
                .lastModified,
            }),
        },
      ],
    };
  }

  private async _readCanonicalAvifPreview(
    folder: MapleFolderHandle,
    relDir: string,
    filename: string,
    source: PreviewSourceIdentity,
    naming: DerivativeNaming,
  ): Promise<CacheHit | NamedRead> {
    const artifactPath = (n: DerivativeNaming) => previewArtifactPath(relDir, filename, 'avif', n);
    const identityPath = (n: DerivativeNaming) => previewIdentityPath(relDir, filename, n);
    const bytes = await this._readOptional(folder, artifactPath(naming));
    if (bytes === null) return 'absent';
    if (!hasCacheImageSignature(bytes, 'avif')) return 'rejected';

    const identityBytes = await this._readOptional(folder, identityPath(naming));
    const matches =
      identityBytes === null
        ? (await this.fs.fileMetadata(folder, artifactPath(naming))).lastModified >=
          source.lastModified
        : recordedIdentityMatches(identityBytes, source);
    if (!matches) return 'rejected';

    const artifact: LegacyFile = { path: artifactPath, bytes: async () => bytes };
    return {
      blob: new Blob([bytes as unknown as BlobPart], { type: 'image/avif' }),
      files:
        identityBytes === null
          ? [artifact]
          : [artifact, { path: identityPath, bytes: async () => identityBytes }],
    };
  }

  private async _readNewerCanonicalAvif(
    folder: MapleFolderHandle,
    relDir: string,
    filename: string,
    naming: DerivativeNaming,
    describedArtifactMtime: number,
  ): Promise<CacheHit | null> {
    const artifactPath = (n: DerivativeNaming) => previewArtifactPath(relDir, filename, 'avif', n);
    let canonicalMtime: number;
    try {
      canonicalMtime = (await this.fs.fileMetadata(folder, artifactPath(naming))).lastModified;
    } catch {
      return null;
    }
    if (canonicalMtime <= describedArtifactMtime) return null;

    const bytes = await this._readOptional(folder, artifactPath(naming));
    if (bytes === null || !hasCacheImageSignature(bytes, 'avif')) return null;
    return {
      blob: new Blob([bytes as unknown as BlobPart], { type: 'image/avif' }),
      files: [{ path: artifactPath, bytes: async () => bytes }],
    };
  }

  // ── Legacy `.v25` adoption (#4793) ──────────────────────────────────────────

  private async _readWithLegacyFallback(
    folder: MapleFolderHandle,
    read: (naming: DerivativeNaming) => Promise<CacheHit | NamedRead>,
  ): Promise<Blob | null> {
    const current = await read('');
    if (current !== 'absent') return current === 'rejected' ? null : current.blob;
    const legacy = await read(LEGACY_DERIVATIVE_SEGMENT);
    if (legacy === 'absent' || legacy === 'rejected') return null;
    if (folder.write) {
      await this._moveFiles(
        folder,
        legacy.files.map((file) => ({
          from: file.path(LEGACY_DERIVATIVE_SEGMENT),
          to: file.path(''),
          bytes: file.bytes,
        })),
      );
    }
    return legacy.blob;
  }

  /** Move each legacy file to its new name: every write lands before any
   * legacy name is removed, so a failure part-way leaves the legacy set intact
   * and readable on the next miss. */
  private async _moveFiles(folder: MapleFolderHandle, moves: readonly FileMove[]): Promise<void> {
    try {
      for (const move of moves) {
        await this.fs.writeFile(folder, move.to, await move.bytes());
      }
      for (const move of moves) {
        await this.fs.removeFile(folder, move.from);
      }
    } catch (err) {
      console.warn('MapleCacheService: failed to rename a legacy .v25 derivative', err);
    }
  }

  private async _readOptional(folder: MapleFolderHandle, path: string): Promise<Uint8Array | null> {
    try {
      return await this.fs.readFile(folder, path);
    } catch {
      return null;
    }
  }
}

/** `absent` — no file at this naming at all (the only state that consults the
 * legacy name); `rejected` — present but unusable (stale, corrupt, mismatched). */
type NamedRead = 'absent' | 'rejected';

interface LegacyFile {
  readonly path: (naming: DerivativeNaming) => string;
  readonly bytes: () => Promise<Uint8Array>;
}

interface FileMove {
  readonly from: string;
  readonly to: string;
  readonly bytes: () => Promise<Uint8Array>;
}

interface CacheHit {
  readonly blob: Blob;
  readonly files: readonly LegacyFile[];
}

// Blob requires an ArrayBuffer; readFile's Uint8Array is typed ArrayBufferLike.
function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function encodeDescriptor(descriptor: PreviewCacheDescriptor): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(descriptor));
}

function recordedIdentityMatches(bytes: Uint8Array, source: PreviewSourceIdentity): boolean {
  try {
    const recorded = JSON.parse(new TextDecoder().decode(bytes)) as PreviewSourceIdentity;
    return validPreviewSource(recorded) && samePreviewSource(recorded, source);
  } catch {
    return false;
  }
}
