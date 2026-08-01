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
import { hasCacheImageSignature } from './cache-image-format';

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

/** Directory holding an asset's unedited-preview cache, relative to the
 * library root. `relDir` is the asset's OWN directory (`''` for a root-level
 * asset) — the `.maple/previews/` folder sits alongside the asset, matching
 * the canonical cross-platform layout the server/Apple write
 * (`<dir>/.maple/previews/`), not the single root `.maple/thumbs/` the web
 * thumb tier still uses. */
function previewCacheDir(relDir: string): string {
  return relDir ? `${relDir}/.maple/previews` : '.maple/previews';
}

/** Canonical preview cache path: `<relDir>/.maple/previews/<filename>.avif`,
 * where `filename` includes the original extension (e.g. `IMG_1234.CR2` →
 * `.../previews/IMG_1234.CR2.avif`). */
function previewCachePath(relDir: string, filename: string): string {
  return `${previewCacheDir(relDir)}/${filename}.avif`;
}

export interface PreviewSourceIdentity {
  size: number;
  lastModified: number;
}

function previewIdentityPath(relDir: string, filename: string): string {
  return `${previewCachePath(relDir, filename)}.source.json`;
}

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

  /**
   * Read a cached unedited-preview AVIF blob for the asset at
   * `<relDir>/<filename>` within `folder`.
   *
   * Path is the canonical cross-platform preview contract, identical on
   * server/Apple/web: `<relDir>/.maple/previews/<filename>.avif`, where
   * `filename` is the asset's original name INCLUDING its extension and
   * `relDir` is the asset's directory relative to the library root (`''` for a
   * root-level asset). Path-keyed off directory+filename — NOT the
   * content-addressed `maple_id` an earlier draft used, and NOT the
   * filename-sha thumbs use — so a preview written by any client lands exactly
   * where every other client looks for it.
   *
   * Returns null if not cached.
   *
   * No pipeline-version marker (contrast `readThumb`'s `.v` companion): a
   * preview is a pure re-encode of the RAW's own camera-embedded JPEG
   * (`EmbeddedPreviewService`), never touching raw-core's decode/demosaic/AgX
   * chain, so a `PIPELINE_OUTPUT_VERSION` bump can't make it stale. Cache reuse
   * is nevertheless source-gated: Hosted writes record the RAW's exact
   * size+mtime, while unmarked cross-platform entries use the server's
   * derivative-mtime freshness rule.
   */
  async readPreview(
    folder: MapleFolderHandle,
    relDir: string,
    filename: string,
    source: PreviewSourceIdentity,
  ): Promise<Blob | null> {
    try {
      const path = previewCachePath(relDir, filename);
      const bytes = await this.fs.readFile(folder, path);
      if (!hasCacheImageSignature(bytes, 'avif')) return null;
      if (!(await this._previewMatchesSource(folder, relDir, filename, source))) return null;
      // `Blob`'s constructor accepts an `ArrayBufferView` (a `Uint8Array`)
      // directly at runtime — passing `bytes` itself (not `bytes.buffer`) also
      // respects its byteOffset/byteLength if `readFile` ever returns a view
      // over a larger buffer, so this needs neither the extra copy nor the
      // `ArrayBuffer`-only assumption `readThumb` above was written against.
      // The cast is TS-only friction (`lib.dom.d.ts` narrows `BlobPart` to
      // `ArrayBufferView<ArrayBuffer>` and can't statically rule out a
      // `SharedArrayBuffer` backing `readFile` never produces) — same friction
      // `image-utils.ts`'s canvas helpers already cast through.
      return new Blob([bytes as unknown as BlobPart], { type: 'image/avif' });
    } catch {
      return null;
    }
  }

  /**
   * Write an unedited-preview blob to the canonical
   * `<relDir>/.maple/previews/<filename>.avif` path (see `readPreview`).
   * Creates the `.maple/previews/` directory (in the asset's own folder) if
   * necessary. Silently skips if the folder is read-only.
   *
   * `blob` MUST be genuine AVIF: the caller (`HostedPreviewResolver`) only
   * reaches this after `encodePreviewBlobToAvif` produced real AVIF, precisely
   * so a browser that can't encode AVIF never lands a mislabeled `.avif` here
   * (exactly the format the server's #2014 validator rejects on a real decode).
   * The `.avif` extension is fixed by the cross-platform contract, so unlike
   * `writeThumb` there is no format parameter.
   */
  async writePreview(
    folder: MapleFolderHandle,
    relDir: string,
    filename: string,
    blob: Blob,
    source?: PreviewSourceIdentity,
  ): Promise<void> {
    if (!folder.write) return;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!hasCacheImageSignature(bytes, 'avif')) {
        console.warn(`MapleCacheService: refused non-AVIF preview ${relDir}/${filename}`);
        return;
      }
      await this.fs.ensureSubdirectory(folder, previewCacheDir(relDir));
      await this.fs.writeFile(folder, previewCachePath(relDir, filename), bytes);
      if (source) {
        await this.fs.writeFile(
          folder,
          previewIdentityPath(relDir, filename),
          new TextEncoder().encode(JSON.stringify(source)),
        );
      }
    } catch (err) {
      console.warn(`MapleCacheService: failed to write preview ${relDir}/${filename}`, err);
    }
  }

  private async _previewMatchesSource(
    folder: MapleFolderHandle,
    relDir: string,
    filename: string,
    source: PreviewSourceIdentity,
  ): Promise<boolean> {
    try {
      const bytes = await this.fs.readFile(folder, previewIdentityPath(relDir, filename));
      const recorded = JSON.parse(new TextDecoder().decode(bytes)) as PreviewSourceIdentity;
      return recorded.size === source.size && recorded.lastModified === source.lastModified;
    } catch {
      // Cross-platform entries predate the Hosted marker. Preserve the server's
      // canonical freshness rule for those: derivative mtime must not precede
      // the source. Hosted writes add the exact size+mtime marker above.
      try {
        const metadata = await this.fs.fileMetadata(folder, previewCachePath(relDir, filename));
        return metadata.lastModified >= source.lastModified;
      } catch {
        return false;
      }
    }
  }
}
