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
      await this.fs.ensureSubdirectory(folder, '.maple/thumbs');
      const bytes = new Uint8Array(await blob.arrayBuffer());
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

  // ── Previews (embedded-RAW-preview extraction, #2010) ────────────────────

  /**
   * Read a cached extracted-embedded-preview blob. `mapleId` is the asset's
   * content-derived `maple_id` (`FsAccessLibrarySource.mapleId`) — NOT the
   * filename sha thumbs use above. Previews are content-addressed here
   * (unlike the server's path/filename-keyed `.maple/previews/` tier, per
   * epic #1993's design update) so duplicate files at different paths
   * within the same folder tree share one cached extraction — the same
   * multi-location win `dedupe.ts` already gets from content-addressing
   * thumbs server-side.
   *
   * Returns null if not cached.
   *
   * No pipeline-version marker (contrast `readThumb`'s `.v` companion): a
   * Hosted preview is a pure re-encode of the RAW's own embedded JPEG
   * (`EmbeddedPreviewService.extractEmbeddedPreview`) — it never touches
   * raw-core's decode/demosaic/AgX chain, so a `PIPELINE_OUTPUT_VERSION`
   * bump can't make a cached preview stale. Every entry under
   * `.maple/previews/` is trusted as-is, the same way a foreign
   * (server/Apple-written) thumb with no `.v` marker is trusted above.
   */
  async readPreview(folder: MapleFolderHandle, mapleId: string): Promise<Blob | null> {
    try {
      const bytes = await this.fs.readFile(folder, `.maple/previews/${mapleId}.jpg`);
      // `Blob`'s constructor accepts an `ArrayBufferView` (a `Uint8Array`)
      // directly at runtime — passing `bytes` itself (not `bytes.buffer`)
      // also correctly respects its byteOffset/byteLength if `readFile`
      // ever returns a view over a larger buffer, so this needs neither the
      // extra copy nor the `ArrayBuffer`-only assumption `readThumb` above
      // was written against. The cast is TS-only friction: `lib.dom.d.ts`
      // types `Uint8Array` as generic over its buffer (`Uint8Array<ArrayBufferLike>`
      // by default) and narrows `BlobPart` to `ArrayBufferView<ArrayBuffer>`
      // specifically, so it can't statically rule out a `SharedArrayBuffer`
      // backing here even though `readFile` never produces one — same
      // known friction `image-utils.ts`'s `canvasToBlob`/`blobToBytes`
      // already cast through.
      return new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' });
    } catch {
      return null;
    }
  }

  /**
   * Write an extracted-embedded-preview JPEG blob, keyed by `mapleId` (see
   * `readPreview`). Creates `.maple/previews/` if necessary. Silently skips
   * if the folder is read-only.
   *
   * JPEG only — `raw-wasm` doesn't enable raw-core's `avif` feature (kept
   * off there so the wasm32 build never pulls in the `ravif`/`rav1e` AV1
   * encoder; see `raw-core/Cargo.toml`'s `avif` feature comment), so unlike
   * `writeThumb` there's no AVIF variant of this client-generated artefact
   * yet.
   */
  async writePreview(folder: MapleFolderHandle, mapleId: string, blob: Blob): Promise<void> {
    if (!folder.write) return;
    try {
      await this.fs.ensureSubdirectory(folder, '.maple/previews');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await this.fs.writeFile(folder, `.maple/previews/${mapleId}.jpg`, bytes);
    } catch (err) {
      console.warn(`MapleCacheService: failed to write preview ${mapleId}`, err);
    }
  }
}
