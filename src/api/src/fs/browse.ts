// src/api/src/fs/browse.ts
//
// Filesystem browse helper for the library-picker UI.
//
// Lists subdirectories under a path with a `MAPLE_ROOTS` jail (default '/')
// and a system-directory denylist that hides /proc, /etc, /usr, /app, ... at
// the filesystem root unless `showAll` is true.

import { readdir, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { OpResult } from './root.ts';
import { SHARP_EXTENSIONS } from '../thumbs/render.ts';

export interface DirEntry {
  name: string;
  path: string; // absolute, symlink-resolved
  hasChildren: boolean;
}

export interface DirListing {
  path: string; // absolute, symlink-resolved
  parent: string | null;
  entries: DirEntry[];
}

/** Linux/macOS directory names hidden at the filesystem root unless showAll=1. */
export const SYSTEM_DIRS = new Set<string>([
  'proc',
  'sys',
  'dev',
  'run',
  'boot',
  'bin',
  'sbin',
  'lib',
  'lib32',
  'lib64',
  'usr',
  'etc',
  'var',
  'tmp',
  'root',
  'opt',
  'srv',
  'private', // macOS
  'app', // container working dir
  'node_modules',
]);

export async function browseRoots(): Promise<string[]> {
  const env = process.env.MAPLE_ROOTS;
  if (!env || env.trim() === '') return ['/'];
  // Strip trailing slash unless the entry IS just "/" — `"/".replace(/\/$/, "")`
  // collapses to "" and then filter(Boolean) drops it, leaving an empty roots
  // list for `MAPLE_ROOTS=/`. Preserve "/" explicitly.
  const raw = env
    .split(':')
    .map((p) => (p === '/' ? '/' : p.replace(/\/$/, '')))
    .filter(Boolean);
  // Resolve symlinks in each root so the jail check works on macOS where
  // /var → /private/var (and the realpath of reqPath will be /private/var/…).
  const resolved = await Promise.all(
    raw.map(async (r) => {
      try {
        return await realpath(r);
      } catch {
        return r;
      }
    }),
  );
  return resolved;
}

export function isUnderRoot(absPath: string, root: string): boolean {
  const r = root.replace(/\/$/, '') || '/';
  if (r === '/') return true;
  return absPath === r || absPath.startsWith(r + '/');
}

export async function listDir(reqPath: string, showAll: boolean): Promise<OpResult<DirListing>> {
  if (!path.isAbsolute(reqPath)) {
    return { ok: false, error: 'Path must be absolute.' };
  }

  let real: string;
  try {
    real = await realpath(reqPath);
  } catch (err) {
    return {
      ok: false,
      error: `Cannot access "${reqPath}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const roots = await browseRoots();
  if (!roots.some((r) => isUnderRoot(real, r))) {
    return {
      ok: false,
      error: `Path "${real}" is outside MAPLE_ROOTS [${roots.join(', ')}]`,
    };
  }

  let rawEntries: { name: string }[];
  try {
    rawEntries = await readdir(real, { withFileTypes: false }).then((names) =>
      names.map((n) => ({ name: n })),
    );
  } catch (err) {
    return {
      ok: false,
      error: `Cannot list "${real}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const atRoot = real === '/';

  // Pre-filter by name (hidden files, system dirs at root) before the
  // per-entry async work so we skip obviously unwanted entries cheaply.
  const candidates = rawEntries
    .filter((e) => !e.name.startsWith('.'))
    .filter((e) => showAll || !atRoot || !SYSTEM_DIRS.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const out: DirEntry[] = [];
  for (const e of candidates) {
    const childCandidate = real === '/' ? '/' + e.name : `${real}/${e.name}`;

    // Issue 1 fix: re-resolve the child's realpath and re-check the jail to
    // prevent symlink-swap attacks between parent readdir and child access.
    let childReal: string;
    try {
      childReal = await realpath(childCandidate);
    } catch {
      // Broken symlink or permission denied — drop entry entirely.
      continue;
    }
    if (!roots.some((r) => isUnderRoot(childReal, r))) {
      // Child escaped the jail (e.g. symlink pointing outside MAPLE_ROOTS).
      // Drop the entry — including its path would leak information.
      continue;
    }

    // Issue 2 fix: use stat() (follows symlinks) to confirm the target is
    // actually a directory. Symlinks to files are silently dropped.
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(childReal);
    } catch {
      // Permission denied or race — drop entry.
      continue;
    }
    if (!st.isDirectory()) continue;

    // Compute hasChildren using the jail-verified, realpath-resolved path.
    let hasChildren = false;
    try {
      const sub = await readdir(childReal, { withFileTypes: true });
      hasChildren = sub.some(
        (s) => !s.name.startsWith('.') && (s.isDirectory() || s.isSymbolicLink()),
      );
    } catch {
      // Permission denied / unreadable — show but mark childless.
      hasChildren = false;
    }

    out.push({ name: e.name, path: childReal, hasChildren });
  }

  // Issue 3 fix: return realpath form consistently for DirListing.path,
  // DirListing.parent, and entries[].path so the picker UI never sees a
  // path-style flip (e.g. /var vs /private/var on macOS) mid-navigation.
  const isRoot = real === '/';
  return {
    ok: true,
    data: {
      path: real,
      parent: isRoot ? null : path.dirname(real),
      entries: out,
    },
  };
}

// ---------------------------------------------------------------------------
// listDirContents — used by GET /api/fs/dir to drive the tree-view that
// shows folders + image files at each level.
// ---------------------------------------------------------------------------

/** RAW file extensions handled by the libraw FFI pipeline (lowercase, no dot).
 * Used by `/api/fs/raw` (byte stream into WASM decode) and the thumb endpoint
 * to choose between the libraw FFI and the sharp/heic-convert path. */
export const RAW_EXTENSIONS = new Set<string>([
  'cr2',
  'cr3',
  'nef',
  'arw',
  'dng',
  'raf',
  'orf',
  'rw2',
  'pef',
  'srw',
]);

/** All image extensions surfaced by the directory listing. Union of RAWs
 * (decoded via FFI) and bitmap formats (decoded via sharp/heic-convert).
 * Kept in sync with the thumb endpoint's extension gate. */
const IMAGE_EXTENSIONS = new Set<string>([...RAW_EXTENSIONS, ...SHARP_EXTENSIONS]);

export interface DirChild {
  name: string;
  path: string; // absolute, symlink-resolved
  mtime: string; // ISO-8601
}

export interface ImageChild extends DirChild {
  size: number; // bytes
  ext: string; // lowercase, no dot;
}

export interface SidecarChild {
  name: string;
  path: string; // absolute, symlink-resolved
  mtime: string; // ISO-8601
  size: number; // bytes
}

export interface DirContents {
  path: string;
  parent: string | null;
  dirs: DirChild[];
  images: ImageChild[];
  sidecars: SidecarChild[];
  /** Opaque continuation token; present when the listing is paged and more
   *  remains. Absent / null when the listing is complete. */
  next_cursor?: string;
}

export interface ListDirOptions {
  cursor?: string;
  /** Page size. Defaults to 500. Clamped to [1, 2000]. */
  limit?: number;
}

/** Opaque cursor format: base64url of {"offset":N}. Server is free to
 *  change this representation (e.g. switch to a name-sorted resume key)
 *  later — clients must round-trip the string verbatim. */
const CURSOR_MAX_OFFSET = 1_000_000;

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

export function decodeCursor(s: string): number {
  let obj: unknown;
  try {
    obj = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    throw new Error(`malformed cursor: ${s}`);
  }
  if (
    typeof obj !== 'object' ||
    obj === null ||
    typeof (obj as { offset?: unknown }).offset !== 'number'
  ) {
    throw new Error(`malformed cursor: ${s}`);
  }
  const n = (obj as { offset: number }).offset;
  if (!Number.isInteger(n) || n < 0 || n > CURSOR_MAX_OFFSET) {
    throw new Error(`cursor offset out of range: ${n}`);
  }
  return n;
}

/**
 * List a single directory level: subdirectories + image files.
 *
 * - Hides dotfiles/dotdirs (including the `.maple/` cache dir).
 * - Filters images to IMAGE_EXTENSIONS — RAWs + the bitmap formats the thumb
 *   endpoint can render (case-insensitive).
 * - Enforces the same MAPLE_ROOTS jail as `listDir`, including a per-child
 *   realpath re-check so a symlink swap can't escape the jail.
 * - Does NOT recurse.
 */
export async function listDirContents(
  reqPath: string,
  opts: ListDirOptions = {},
): Promise<OpResult<DirContents>> {
  if (!path.isAbsolute(reqPath)) {
    return { ok: false, error: 'Path must be absolute.' };
  }

  let real: string;
  try {
    real = await realpath(reqPath);
  } catch (err) {
    return {
      ok: false,
      error: `Cannot access "${reqPath}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const roots = await browseRoots();
  if (!roots.some((r) => isUnderRoot(real, r))) {
    return {
      ok: false,
      error: `Path "${real}" is outside MAPLE_ROOTS [${roots.join(', ')}]`,
    };
  }

  let names: string[];
  try {
    names = await readdir(real);
  } catch (err) {
    return {
      ok: false,
      error: `Cannot list "${real}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const visible = names.filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b));

  // Paging window. cursor === undefined AND limit === undefined keeps
  // the historical single-shot behaviour (no slicing, no next_cursor).
  // Any cursor OR limit query param triggers paged mode.
  const pagedMode = opts.cursor !== undefined || opts.limit !== undefined;
  let offset = 0;
  if (opts.cursor !== undefined) {
    try {
      offset = decodeCursor(opts.cursor);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const limit = pagedMode ? Math.max(1, Math.min(2000, opts.limit ?? 500)) : visible.length;
  const slice = pagedMode ? visible.slice(offset, offset + limit) : visible;
  const nextOffset = pagedMode && offset + limit < visible.length ? offset + limit : null;

  const dirs: DirChild[] = [];
  const images: ImageChild[] = [];

  for (const name of slice) {
    const childCandidate = real === '/' ? '/' + name : `${real}/${name}`;

    // Re-resolve realpath and re-check the jail (symlink-swap defence).
    let childReal: string;
    try {
      childReal = await realpath(childCandidate);
    } catch {
      continue; // broken symlink / permission denied
    }
    if (!roots.some((r) => isUnderRoot(childReal, r))) continue;

    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(childReal);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      dirs.push({ name, path: childReal, mtime: st.mtime.toISOString() });
    } else if (st.isFile()) {
      const dot = name.lastIndexOf('.');
      if (dot < 0) continue;
      const ext = name.slice(dot + 1).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        images.push({
          name,
          path: childReal,
          size: st.size,
          mtime: st.mtime.toISOString(),
          ext,
        });
      }
      // .xmp sidecars are intentionally NOT surfaced here. Editing surfaces
      // (`/api/fs/raw`, the editor cold-load path) discover the matching
      // sidecar relative to the RAW on their own; browsing only needs the
      // image list.
    }
  }

  const isRoot = real === '/';
  return {
    ok: true,
    data: {
      path: real,
      parent: isRoot ? null : path.dirname(real),
      dirs,
      images,
      // Always empty — sidecars are an editor concern, not a browse one.
      // Kept in the response shape so existing clients that destructure
      // `{ sidecars }` don't crash on undefined.
      sidecars: [],
      ...(nextOffset !== null ? { next_cursor: encodeCursor(nextOffset) } : {}),
    },
  };
}
