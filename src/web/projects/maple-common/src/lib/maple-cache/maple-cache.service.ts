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

  /**
   * Read a cached thumbnail blob.
   * `sha` is the 16-char hex prefix (sha256Prefix16(filename)).
   * Returns null if not cached — or if a Hosted-written thumb is stale.
   *
   * Pipeline-version guard (#1927): a thumb this client developed carries a
   * `<sha>.jpg.v` companion recording `THUMB_PIPELINE_VERSION`. When that
   * marker is older than the current version the cached pixels predate a
   * raw-core/AgX change, so we miss and force a re-decode. A thumb with NO
   * marker is foreign — written by the server or native app, which extract
   * the embedded preview (pipeline-version-independent) — and is trusted
   * as-is, preserving the portable `.maple/thumbs/<sha>.jpg` cross-platform
   * contract. The `.jpg.v` companion mirrors the API's `<thumb>.meta`
   * sidecar pattern (`routes/fs-thumbs.ts`).
   */
  async readThumb(folder: MapleFolderHandle, sha: string): Promise<Blob | null> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fs.readFile(folder, `.maple/thumbs/${sha}.jpg`);
    } catch {
      return null;
    }
    const markerVersion = await this._readThumbVersion(folder, sha);
    if (markerVersion !== null && markerVersion < THUMB_PIPELINE_VERSION) {
      return null; // stale locally-developed thumb → re-decode
    }
    // Copy into a fresh plain ArrayBuffer (readFile returns Uint8Array whose
    // .buffer may be typed as ArrayBufferLike; Blob requires ArrayBuffer).
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return new Blob([ab], { type: 'image/jpeg' });
  }

  /**
   * Write a thumbnail blob plus its pipeline-version companion (#1927).
   * Creates `.maple/thumbs/` if necessary.
   * Silently skips if the folder is read-only.
   */
  async writeThumb(folder: MapleFolderHandle, sha: string, blob: Blob): Promise<void> {
    if (!folder.write) return;
    try {
      await this.fs.ensureSubdirectory(folder, '.maple/thumbs');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await this.fs.writeFile(folder, `.maple/thumbs/${sha}.jpg`, bytes);
      // Stamp the pipeline version this thumb was developed at so a later
      // raw-core/AgX bump invalidates it on read (see readThumb).
      await this.fs.writeFile(
        folder,
        `.maple/thumbs/${sha}.jpg.v`,
        new TextEncoder().encode(String(THUMB_PIPELINE_VERSION)),
      );
    } catch (err) {
      console.warn(`MapleCacheService: failed to write thumb ${sha}`, err);
    }
  }

  /**
   * Read the pipeline-version marker for a cached thumb.
   *   - `null`  — marker ABSENT (a foreign/embedded thumb; `readThumb` trusts it).
   *   - `N`     — the parsed version.
   *   - `-1`    — marker PRESENT but unparseable (e.g. a partial write). A
   *               corrupt marker belongs to a locally-developed thumb whose
   *               version stamp is broken, so force a re-decode rather than
   *               trust it: -1 is always below `THUMB_PIPELINE_VERSION`.
   */
  private async _readThumbVersion(folder: MapleFolderHandle, sha: string): Promise<number | null> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fs.readFile(folder, `.maple/thumbs/${sha}.jpg.v`);
    } catch {
      return null; // absent → foreign thumb, trust
    }
    const parsed = Number.parseInt(new TextDecoder().decode(bytes).trim(), 10);
    return Number.isFinite(parsed) ? parsed : -1;
  }
}
