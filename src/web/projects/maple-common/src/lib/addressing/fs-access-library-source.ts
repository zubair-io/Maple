// FsAccessLibrarySource — LibrarySource impl for Hosted (FS-Access) mode.
//
// Resolves addresses by walking FileSystemDirectoryHandles registered in
// LibrarySlugRegistry. thumbUrl returns a blob: URL from the local thumb
// cache (.maple/thumbs/<sha>.jpg); content-key alignment with the Self-Hosted
// system is deferred to M3.

import { Injectable, inject } from '@angular/core';
import { childAddress, formatAddress, parentAddress, parseAddress } from './maple-address';
import type { MapleAddress } from './maple-address';
import type { LibrarySource, FolderListing, ImageEntry } from './library-source';
import { LibrarySlugRegistry } from './library-slug-registry';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { sha256Prefix16 } from '../maple-cache/sha';

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
  const segments = relPath.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error(`Rejected traversal segment in relPath: ${JSON.stringify(relPath)}`);
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

  async imageBlob(a: MapleAddress): Promise<Blob> {
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

  async thumbUrl(a: MapleAddress): Promise<string> {
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
    const cached = await this.cache.readThumb(
      rootHandle as unknown as Parameters<typeof this.cache.readThumb>[0],
      sha,
    );
    if (cached) {
      return URL.createObjectURL(cached);
    }
    // No cached thumb → fall back to generating from file bytes (caller
    // handles this via LibraryCache.ensureThumbnailUrl). Return empty string
    // so the caller knows to trigger the generation path.
    return '';
  }

  async previewUrl(a: MapleAddress): Promise<string> {
    // Hosted preview: same path as thumb for now. Full preview generation is M3.
    return this.thumbUrl(a);
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
