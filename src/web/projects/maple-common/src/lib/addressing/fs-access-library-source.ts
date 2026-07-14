// FsAccessLibrarySource — LibrarySource impl for Hosted (FS-Access) mode.
//
// Resolves addresses by walking FileSystemDirectoryHandles registered in
// LibrarySlugRegistry. thumbUrl returns a blob: URL from the local thumb
// cache (.maple/thumbs/<sha>.avif, or .jpg for legacy/pre-AVIF-migration
// entries — see MapleCacheService); content-key alignment with the
// Self-Hosted system is deferred to M3.

import { Injectable, inject } from '@angular/core';
import { childAddress, formatAddress, parentAddress } from './maple-address';
import type { MapleAddress } from './maple-address';
import type { LibrarySource, FolderListing, ImageEntry } from './library-source';
import type { DownloadProgress } from '../api/filesystem-browse.service';
import { LibrarySlugRegistry } from './library-slug-registry';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { sha256Prefix16 } from '../maple-cache/sha';
import { HostedMapleIdService } from './hosted-maple-id.service';

/** Filesystem entry shape for unit-testable pure helpers. */
export interface FsEntry {
  kind: 'file' | 'directory';
  name: string;
}

/**
 * Validate a relPath string for security: reject traversal (..), absolute
 * paths, and backslashes. Throws a descriptive Error on violation.
 */
export function validateRelPath(relPath: string): void {
  if (relPath.startsWith('/')) {
    throw new Error(`Rejected absolute relPath: ${JSON.stringify(relPath)}`);
  }
  if (relPath.includes('\\')) {
    throw new Error(`Rejected backslash in relPath: ${JSON.stringify(relPath)}`);
  }
  // Allow empty string (the library root itself); reject any path with empty segments
  // (e.g. "a//b" or "a/") which indicate duplicate or trailing slashes.
  if (relPath !== '') {
    const segments = relPath.split('/');
    for (const seg of segments) {
      if (seg === '') {
        throw new Error(`Rejected empty segment in relPath: ${JSON.stringify(relPath)}`);
      }
      if (seg === '..' || seg === '.') {
        throw new Error(`Rejected traversal segment in relPath: ${JSON.stringify(relPath)}`);
      }
    }
  }
}

/**
 * Pure function: build a FolderListing from a directory address and its
 * immediate entries. Filters out dot-files; maps directories to folders,
 * files to images with indexed:true / mapleId:null per the Hosted spec.
 *
 * `parentAddr` may be null for the library root.
 */
export function buildFolderListing(
  addr: MapleAddress,
  entries: FsEntry[],
  _parentAddr: MapleAddress | null,
): FolderListing {
  const parent = parentAddress(addr);
  const visibleEntries = entries.filter((e) => !e.name.startsWith('.'));

  const folders = visibleEntries
    .filter((e) => e.kind === 'directory')
    .map((e) => ({
      name: e.name,
      address: formatAddress(childAddress(addr, e.name)),
    }));

  const images: ImageEntry[] = visibleEntries
    .filter((e) => e.kind === 'file')
    .map((e) => ({
      name: e.name,
      address: formatAddress(childAddress(addr, e.name)),
      mapleId: null,
      indexed: true,
    }));

  return {
    address: formatAddress(addr),
    parent: parent ? formatAddress(parent) : null,
    folders,
    images,
  };
}

@Injectable({ providedIn: 'root' })
export class FsAccessLibrarySource implements LibrarySource {
  private readonly registry = inject(LibrarySlugRegistry);
  private readonly cache = inject(MapleCacheService);
  private readonly mapleIdService = inject(HostedMapleIdService);

  async listFolder(a: MapleAddress): Promise<FolderListing> {
    validateRelPath(a.relPath);
    const rootHandle = await this.registry.getHandle(a.slug);
    if (!rootHandle) {
      throw new Error(`No registered library for slug: ${a.slug}`);
    }
    const dirHandle = await this.walkToDir(rootHandle, a.relPath);
    const entries: FsEntry[] = [];
    for await (const [name, handle] of dirHandle as AsyncIterable<[string, FileSystemHandle]>) {
      entries.push({ kind: handle.kind, name });
    }
    return buildFolderListing(a, entries, null);
  }

  // `onProgress` is part of the `LibrarySource` interface (HttpLibrarySource
  // wires it to the editor's open-progress overlay for a network download)
  // but is unused here: a local FileSystemDirectoryHandle read is
  // effectively instant, nothing to report progress on. Kept in the
  // signature (not dropped) so a caller holding a concrete
  // `FsAccessLibrarySource` reference doesn't need a different call
  // pattern than one holding the interface type.
  async imageBlob(a: MapleAddress, _onProgress?: (p: DownloadProgress) => void): Promise<Blob> {
    return this.getFile(a);
  }

  /**
   * Real `maple_id` for a Hosted-mode local file (#1995), computed on demand
   * (not eagerly during `listFolder` — hashing every file in a folder just to
   * list it would read gigabytes of RAW bytes per folder open, breaking the
   * cold-open performance budget). Cached in IndexedDB keyed by this
   * address's `slug:relPath` and validated against the file's current
   * `size`/`lastModified` — see `HostedMapleIdService` /
   * `maple-id-cache.ts`. `listFolder`'s `ImageEntry.mapleId` stays `null`
   * (content-key alignment with Self-Hosted at the listing level is M3,
   * unchanged by this ticket); callers that need a real id for one asset
   * (e.g. as a preview-cache key) call this directly.
   */
  // Not yet called: capability-first staging for #1996 (Stage 4, the AVIF
  // preview tier), which wires this in as the preview-cache key. Deliberately
  // sequenced, not a stub — implementation is complete and tested (see this
  // class's spec).
  // fallow-ignore-next-line unused-class-member
  async mapleId(a: MapleAddress): Promise<string> {
    validateRelPath(a.relPath);
    const file = await this.getFile(a);
    return this.mapleIdService.getOrComputeMapleId(formatAddress(a), file);
  }

  private async getFile(a: MapleAddress): Promise<File> {
    validateRelPath(a.relPath);
    const rootHandle = await this.registry.getHandle(a.slug);
    if (!rootHandle) {
      throw new Error(`No registered library for slug: ${a.slug}`);
    }
    const { dir, filename } = splitRelPath(a.relPath);
    const dirHandle = await this.walkToDir(rootHandle, dir);
    const fileHandle = await dirHandle.getFileHandle(filename);
    return fileHandle.getFile();
  }

  async thumbBlob(a: MapleAddress): Promise<Blob | null> {
    validateRelPath(a.relPath);
    const rootHandle = await this.registry.getHandle(a.slug);
    if (!rootHandle) {
      throw new Error(`No registered library for slug: ${a.slug}`);
    }
    // Content-key alignment with Self-Hosted (mapleId-keyed) is M3.
    // For now, use the filename sha as the local cache key (matches the
    // existing maple-cache.service.ts pattern).
    const { filename } = splitRelPath(a.relPath);
    const sha = await sha256Prefix16(filename);
    // Wrap the raw FileSystemDirectoryHandle into a MapleFolderHandle so
    // MapleCacheService.readThumb receives the type it expects (it reads the
    // `.maple/thumbs/` subdirectory via FolderAccessService, which needs the
    // `native` property to be set).
    const folderHandle: MapleFolderHandle = {
      name: rootHandle.name,
      read: true,
      write: false,
      native: rootHandle,
    };
    // null on a cache miss — the caller (LibraryCache.ensureThumbnailUrl) checks
    // for null and falls through to its WASM-decode generation path. (Throwing
    // here would unwind to the outer catch and skip that fallback.)
    return (await this.cache.readThumb(folderHandle, sha)) ?? null;
  }

  async previewBlob(a: MapleAddress): Promise<Blob | null> {
    // Hosted preview: same path as thumb for now. Full preview generation is M3.
    return this.thumbBlob(a);
  }

  private async walkToDir(
    root: FileSystemDirectoryHandle,
    relPath: string,
  ): Promise<FileSystemDirectoryHandle> {
    if (relPath === '') return root;
    let cur = root;
    for (const seg of relPath.split('/')) {
      cur = await cur.getDirectoryHandle(seg);
    }
    return cur;
  }
}

function splitRelPath(relPath: string): { dir: string; filename: string } {
  const slash = relPath.lastIndexOf('/');
  if (slash < 0) return { dir: '', filename: relPath };
  return { dir: relPath.slice(0, slash), filename: relPath.slice(slash + 1) };
}
