/**
 * Discover producer — shared types, the supported-extension allowlist, and
 * pure path-normalisation helpers used by `handleEvent` and `startDiscover`.
 *
 * Lifted out of `index.ts` so the public-surface types and the small pure
 * helpers can be imported without dragging in Mongo or the watcher. See
 * `index.ts` for the module-level overview.
 */
import * as path from 'node:path';
import type { ObjectId } from 'mongodb';

export interface DiscoverOptions {
  /** Absolute paths to watch. One path per registered folder root. */
  roots: string[];
  /** File extensions to index (default: the standard SUPPORTED_EXTS set). */
  include?: Set<string>;
  /** Debounce window in ms (default: 250). */
  debounceMs?: number;
}

export interface DiscoverHandle {
  stop: () => Promise<void>;
}

/**
 * Typed event emitted by the reconciliation sweep (or any future event source).
 * Lives in `discover/types.ts` — the canonical reconciliation contract reused
 * by `handleEvent` and `sweeper.ts`.
 */
export interface WatchEvent {
  kind: 'created' | 'modified' | 'removed' | 'renamed';
  absPath: string;
  /** Only set for renames — previous absolute path. */
  fromPath?: string;
}

// Sibling .hidden marker files (for photo hiding) are implicitly skipped because
// they do not match any extension in this set.
export const SUPPORTED_EXTS = new Set([
  // RAW formats decoded via libraw FFI
  '.dng',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.raf',
  '.orf',
  '.rw2',
  '.pef',
  '.srw',
  '.x3f',
  '.3fr',
  '.mef',
  '.erf',
  '.mrw',
  '.raw',
  '.fff',
  // Bitmap formats decoded via sharp / heic-convert
  '.jpg',
  '.jpeg',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  // Video containers — metadata-only indexing via video-metadata.ts
  '.mov',
  '.mp4',
  '.m4v',
  '.avi',
  '.mkv',
  '.webm',
  '.mts',
  '.m2ts',
  '.3gp',
]);

/**
 * Convert `path.relative` output to the POSIX form stored in
 * `FileInfo.path`: `""` for empty/".", forward-slash separators on every
 * host. The API runs on Linux/macOS in production, but normalising here
 * keeps the on-wire contract honest if someone runs the harness on
 * Windows.
 */
export function toPosixRelDir(relDir: string): string {
  if (relDir === '' || relDir === '.') return '';
  return relDir.split(path.sep).join('/');
}

/**
 * Reject absPaths that live inside our own derivative cache. The sweeper
 * filters `.maple/` at directory-walk time (see `sweeper.ts`), so under
 * normal operation handleEvent never sees one of these paths. The check
 * here is defense-in-depth: a future event producer that forgets to
 * filter cannot poison the assets collection with phantom rows whose
 * thumb/preview outputs would land one `.maple/` deeper than themselves
 * and re-feed the indexer next sweep — the recursion that produced
 * `.maple/previews/.maple/previews/.maple/thumbs/…/<hash>.jpg`.
 */
export function isInsideMapleCache(libraryRoot: string, absPath: string): boolean {
  const rel = path.relative(libraryRoot, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return rel.split(path.sep).includes('.maple');
}

/**
 * Build the `fileinfo[0]` entry for a file inside a known library root.
 * Returns null when the file path escapes the library (defensive — should
 * not happen because the watcher only emits events under registered roots,
 * but cheap to check and avoids storing `path: "../escape"`).
 */
export function buildFileinfoEntry(
  libraryRoot: string,
  absPath: string,
  folderId: ObjectId,
): { path: string; filename: string; library_id: ObjectId } | null {
  const relDir = path.relative(libraryRoot, path.dirname(absPath));
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) return null;
  return {
    path: toPosixRelDir(relDir),
    filename: path.basename(absPath),
    library_id: folderId,
  };
}
