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
      const text  = new TextDecoder().decode(bytes);
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
  async writeIndex(
    folder: MapleFolderHandle,
    index: MapleIndex,
  ): Promise<void> {
    if (!folder.write) return;
    try {
      const json  = JSON.stringify(index, null, 2);
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
    const existing = index.assets.find(a => a.filename === patch.filename);
    if (existing) {
      const updated = { ...existing, ...patch };
      return {
        ...index,
        assets: index.assets.map(a => a.filename === patch.filename ? updated : a),
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
      generator: 'maple-hosted',
      assets: [],
    };
  }

  // ── Thumbnails ─────────────────────────────────────────────────────────────

  /**
   * Read a cached thumbnail blob.
   * `sha` is the 16-char hex prefix (sha256Prefix16(filename)).
   * Returns null if not cached.
   */
  async readThumb(
    folder: MapleFolderHandle,
    sha: string,
  ): Promise<Blob | null> {
    try {
      const bytes = await this.fs.readFile(folder, `.maple/thumbs/${sha}.jpg`);
      // Copy into a fresh plain ArrayBuffer (readFile returns Uint8Array whose
      // .buffer may be typed as ArrayBufferLike; Blob requires ArrayBuffer).
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      return new Blob([ab], { type: 'image/jpeg' });
    } catch {
      return null;
    }
  }

  /**
   * Write a thumbnail blob.
   * Creates `.maple/thumbs/` if necessary.
   * Silently skips if the folder is read-only.
   */
  async writeThumb(
    folder: MapleFolderHandle,
    sha: string,
    blob: Blob,
  ): Promise<void> {
    if (!folder.write) return;
    try {
      await this.fs.ensureSubdirectory(folder, '.maple/thumbs');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await this.fs.writeFile(folder, `.maple/thumbs/${sha}.jpg`, bytes);
    } catch (err) {
      console.warn(`MapleCacheService: failed to write thumb ${sha}`, err);
    }
  }

  // ── Previews ───────────────────────────────────────────────────────────────

  /**
   * Read a cached preview blob (1600px, last-seen adjusted state).
   * Returns null if not cached.
   */
  async readPreview(
    folder: MapleFolderHandle,
    sha: string,
  ): Promise<Blob | null> {
    try {
      const bytes = await this.fs.readFile(folder, `.maple/previews/${sha}.jpg`);
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      return new Blob([ab], { type: 'image/jpeg' });
    } catch {
      return null;
    }
  }

  /**
   * Write a preview blob.
   * Creates `.maple/previews/` if necessary.
   * Silently skips if the folder is read-only.
   */
  async writePreview(
    folder: MapleFolderHandle,
    sha: string,
    blob: Blob,
  ): Promise<void> {
    if (!folder.write) return;
    try {
      await this.fs.ensureSubdirectory(folder, '.maple/previews');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await this.fs.writeFile(folder, `.maple/previews/${sha}.jpg`, bytes);
    } catch (err) {
      console.warn(`MapleCacheService: failed to write preview ${sha}`, err);
    }
  }
}
