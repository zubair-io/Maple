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

export const SUPPORTED_EXTS = new Set([
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
  '.jpg',
  '.jpeg',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
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
