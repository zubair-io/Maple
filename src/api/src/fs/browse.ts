// src/api/src/fs/browse.ts
//
// Filesystem browse helper for the library-picker UI.
//
// Lists subdirectories under a path with a `MAPLE_ROOTS` jail (default '/')
// and a system-directory denylist that hides /proc, /etc, /usr, /app, ... at
// the filesystem root unless `showAll` is true.

import { readdir, realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import type { OpResult } from './root.ts';
import { findListingAssetsByFilenames } from '../db/sqlite/repos/assets.by-filename.ts';
import { listFolders } from '../db/sqlite/repos/folders.repo.ts';
import { assetAbsPath } from '../indexer/images.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import {
  AUDIO_EXTENSIONS,
  PSD_HDR_EXTENSIONS,
  RAW_EXTENSIONS,
  SHARP_EXTENSIONS,
  STUB_IMAGE_EXTENSIONS,
} from '../indexer/media-types.ts';
import type { AssetExif } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs/browse');

/**
 * Bounded-concurrency map: processes `items` in parallel but caps the number
 * of concurrent in-flight tasks at `concurrency`. Preserves input order in
 * the result array, matching the semantics of `Promise.all(items.map(fn))`.
 */
async function mapBounded<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

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

/**
 * Memo for {@link browseRoots}, keyed on the raw `MAPLE_ROOTS` value so a test
 * that repoints the jail still gets a fresh resolve. `/api/fs/thumb` calls
 * `browseRoots()` once per request through `resolveJailedFile`, so without this
 * a grid full of thumbnails pays one `realpath()` syscall per configured root
 * per image to re-derive a value that cannot change between requests (#2219).
 */
let browseRootsMemo: {
  env: string | undefined;
  roots: Promise<string[]>;
} | null = null;

export async function browseRoots(): Promise<string[]> {
  const env = process.env.MAPLE_ROOTS;
  // Explicit null check, NOT `browseRootsMemo?.env === env`: with no memo yet
  // and MAPLE_ROOTS unset, that optional chain compares `undefined ===
  // undefined` and reports a hit on an empty memo.
  if (browseRootsMemo !== null && browseRootsMemo.env === env) return browseRootsMemo.roots;
  // Memoise the PROMISE, not the resolved value: the burst this exists to
  // optimise (a grid opening, many thumb requests at once) all arrives before
  // the first resolve, and caching only the settled value would let every one of
  // them start its own `realpath` (jules review, PR #2252). Store before the
  // first await so concurrent callers join this attempt.
  const roots = resolveBrowseRoots(env);
  browseRootsMemo = { env, roots };
  // A rejection must not be cached — the next call should retry rather than
  // inherit a permanently-failed promise. (`resolveBrowseRoots` swallows
  // per-root `realpath` failures today, so this is belt-and-braces.)
  roots.catch(() => {
    if (browseRootsMemo?.roots === roots) browseRootsMemo = null;
  });
  return roots;
}

/**
 * Roots accepted by the enriched `/api/fs/dir` listing.
 *
 * Unlike the server-filesystem picker (`/api/fs/list`), File Provider starts
 * from rows returned by `/api/folders`. A registered library is already a
 * jailed browse boundary (the slug-addressed web API uses the same boundary),
 * so `/api/fs/dir` must accept it even when an operator later narrows
 * `MAPLE_ROOTS`. Otherwise the server advertises a library that Finder can
 * never enumerate.
 *
 * Resolve registered paths before comparing so symlinked mounts use the same
 * canonical form as the requested directory. A failed DB/cache lookup falls
 * back to the configured roots; it must never widen access to `/` on error.
 *
 * The resolved paths are memoized per libraries-cache instance (WeakMap key):
 * Finder enumerates this endpoint constantly, and the `realpath()` syscalls
 * per registered library cannot change until the libraries cache invalidates,
 * which hands out a fresh Map instance and naturally misses the memo.
 */
const registeredRootsMemo = new WeakMap<ReadonlyMap<string, string>, Promise<string[]>>();

async function fileProviderBrowseRoots(): Promise<string[]> {
  const configured = await browseRoots();
  try {
    const libraries = await loadLibraryRoots();
    const memoized = registeredRootsMemo.get(libraries);
    const resolving =
      memoized ??
      Promise.all(
        Array.from(libraries.values(), async (root) => {
          try {
            return await realpath(root);
          } catch {
            return path.resolve(root);
          }
        }),
      );
    if (!memoized) registeredRootsMemo.set(libraries, resolving);
    const registered = await resolving;
    return Array.from(new Set([...configured, ...registered]));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'could not load registered roots for File Provider browse',
    );
    return configured;
  }
}

async function resolveBrowseRoots(env: string | undefined): Promise<string[]> {
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
  const opened = await openDirectory(reqPath, browseRoots);
  if ('error' in opened) return opened;
  const { real, roots, names } = opened;
  const rawEntries = names.map((name) => ({ name }));

  const atRoot = real === '/';

  // Pre-filter by name (hidden files, system dirs at root) before the
  // per-entry async work so we skip obviously unwanted entries cheaply.
  const candidates = rawEntries
    .filter((e) => !e.name.startsWith('.'))
    .filter((e) => showAll || !atRoot || !SYSTEM_DIRS.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Cap concurrency: listDir has no paging (it returns all subdirs), so a
  // large directory would otherwise fan out thousands of fs ops at once.
  // 32 concurrent tasks saturates typical local-disk throughput without
  // creating unbounded memory pressure or fd exhaustion.
  const results = await mapBounded(candidates, 32, async (e) => {
    const childCandidate = real === '/' ? '/' + e.name : `${real}/${e.name}`;

    // Issue 1 fix: re-resolve the child's realpath and re-check the jail to
    // prevent symlink-swap attacks between parent readdir and child access.
    let childReal: string;
    try {
      childReal = await realpath(childCandidate);
    } catch {
      // Broken symlink or permission denied — drop entry entirely.
      return null;
    }
    if (!roots.some((r) => isUnderRoot(childReal, r))) {
      // Child escaped the jail (e.g. symlink pointing outside MAPLE_ROOTS).
      // Drop the entry — including its path would leak information.
      return null;
    }

    // Issue 2 fix: use stat() (follows symlinks) to confirm the target is
    // actually a directory. Symlinks to files are silently dropped.
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(childReal);
    } catch {
      // Permission denied or race — drop entry.
      return null;
    }
    if (!st.isDirectory()) return null;

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

    return { name: e.name, path: childReal, hasChildren };
  });

  const out = results.filter((r): r is DirEntry => r !== null);

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

// The per-format extension allowlists (RAW / bitmap / PSD+HDR / stub / audio)
// live in `indexer/media-types.ts`, a leaf module with no imports beyond
// `node:path`, so `indexer/thumbnailer.ts` and `indexer/previewer.ts` can
// read them without importing this file — which would close the
// browse → workers/discover → workers/stages → indexer/* → browse cycle
// (#1988). Re-exported here so the existing route importers keep working.
export {
  AUDIO_EXTENSIONS,
  PSD_HDR_EXTENSIONS,
  RAW_EXTENSIONS,
  SHARP_EXTENSIONS,
  STUB_IMAGE_EXTENSIONS,
} from '../indexer/media-types.ts';

/** All image extensions surfaced by the directory listing. Union of RAWs
 * (decoded via FFI), bitmap formats (decoded via maple/heic-convert), and
 * PSD/PSB/HDR (decoded via ag-psd/hdr then maple). Kept in sync with the
 * thumb endpoint's extension gate. */
const IMAGE_EXTENSIONS = new Set<string>([
  ...RAW_EXTENSIONS,
  ...SHARP_EXTENSIONS,
  ...PSD_HDR_EXTENSIONS,
]);

/** Video container extensions surfaced in the listing alongside images (lowercase, no dot). */
const VIDEO_EXTENSIONS = new Set<string>([
  'mov',
  'mp4',
  'm4v',
  'avi',
  'mkv',
  'webm',
  'mts',
  'm2ts',
  '3gp',
  'mxf',
  '3g2',
  'flv',
  'vob',
  'mpg',
  'wmv',
  'f4v',
]);

/** Which non-decodable-but-listable bucket an extension falls into, if any.
 * `null` for a plain decodable image extension (`IMAGE_EXTENSIONS`) or an
 * extension recognised by none of the listing buckets. Shared by
 * `listDirContents` and `listDirFast` so the video/stub/audio classification
 * used to flag an `ImageChild`/`FastImageChild` entry can't drift between the
 * two listing paths (see #1835). */
function classifyMediaKind(ext: string): 'isVideo' | 'isStub' | 'isAudio' | null {
  if (VIDEO_EXTENSIONS.has(ext)) return 'isVideo';
  if (STUB_IMAGE_EXTENSIONS.has(ext)) return 'isStub';
  if (AUDIO_EXTENSIONS.has(ext)) return 'isAudio';
  return null;
}

/** True when `ext` belongs in the `images[]` listing bucket — a decodable
 * image, or any of the video/stub/audio kinds `classifyMediaKind` recognises.
 * Shared by `listDirContents` and `listDirFast`. */
function isListableMediaExt(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext) || classifyMediaKind(ext) !== null;
}

/** Build the pushed `images[]` entry (shared shape between `ImageChild` and
 * `FastImageChild`) for a listed file, attaching the `isVideo`/`isStub`/
 * `isAudio` flag `classifyMediaKind` returns, if any. */
function buildMediaListItem(
  name: string,
  childReal: string,
  st: { size: number; mtime: Date },
  ext: string,
): {
  name: string;
  path: string;
  size: number;
  mtime: string;
  ext: string;
} & Partial<Record<'isVideo' | 'isStub' | 'isAudio', true>> {
  const kind = classifyMediaKind(ext);
  return {
    name,
    path: childReal,
    size: st.size,
    mtime: st.mtime.toISOString(),
    ext,
    ...(kind !== null ? { [kind]: true } : {}),
  };
}

/**
 * Match a sidecar filename and return the filename of the primary it pairs to.
 *
 * Images use the stem-swap convention — the base has no extension, so it pairs
 * to a primary by its filename stem:
 *   IMG_1.xmp                               → IMG_1
 *   IMG_1 (conflict from MacBook).xmp       → IMG_1
 *   IMG_1 (conflict from MacBook) (2).xmp   → IMG_1
 *
 * Videos use the full-name convention (`clip.mov` → `clip.mov.xmp`) so a Live
 * Photo's motion clip gets its own sidecar instead of clobbering the still's.
 * Stripping only the trailing `.xmp` leaves the video's own extension intact,
 * so the base pairs to the video by its FULL filename:
 *   IMG_1234.MOV.xmp                        → IMG_1234.MOV
 *
 *   notes.txt                               → null (not a sidecar)
 *
 * The optional ` (N)` numeric suffix is produced by `pickFreeConflictPath`
 * when multiple writers race on the same conflict-copy filename.
 */
export function canonicalBaseFromSidecarFilename(filename: string): string | null {
  const m = /^(.+?)( \(conflict from [^)]+\))?( \(\d+\))?\.xmp$/i.exec(filename);
  return m ? m[1] : null;
}

export interface DirChild {
  name: string;
  path: string; // absolute, symlink-resolved
  mtime: string; // ISO-8601
}

export interface ImageChild extends DirChild {
  size: number; // bytes
  ext: string; // lowercase, no dot
  /**
   * `_id` of the matching asset, hex-encoded. Set when this file
   * has been indexed; `undefined` when the indexer hasn't seen it yet. The
   * client uses this to call `/api/assets/:id` for the enriched detail
   * payload (place, faces, description, vision) — FS-walk assets have no other
   * route back to the asset doc since their local id is `fs:${abs_path}`.
   */
  id?: string;
  /**
   * Indexed EXIF for this RAW (camera/lens/exposure/captured_at/gps), looked
   * up by `abs_path` against the `assets` table. `null` when the indexer
   * processed this file but found no usable EXIF; `undefined` when the file
   * hasn't been indexed yet (or the indexer hasn't run for this folder).
   */
  exif?: AssetExif | null;
  /** True when the file is a video container (e.g. .mov, .mp4). */
  isVideo?: true;
  /** True when the file is a metadata-only stub image with no decoder (e.g.
   * .eip, .braw, .afphoto, .ai). See #1835. */
  isStub?: true;
  /** True when the file is an audio format (e.g. .mp3, .wav, .m4a, .aac).
   * See #1835. */
  isAudio?: true;
}

export interface SidecarChild {
  name: string;
  path: string; // absolute, symlink-resolved
  mtime: string; // ISO-8601
  size: number; // bytes
  /**
   * Hex `_id` of the asset this XMP is paired to. Always set —
   * sidecars without a matching indexed asset are dropped from the
   * listing (same filter as `images`).
   */
  asset_id: string;
}

/**
 * A regular file that is neither an indexed-image candidate nor an `.xmp`
 * sidecar — e.g. a PDF, a `.mov`, a `.txt`, or an extensionless file. These
 * are stored on disk and surfaced through the File Provider so it can sync
 * *all* file types, but they get no `AssetDoc` (the database stays
 * image-only). Addressed by `(folderID, relativePath)` on the client, not by
 * an asset id.
 */
export interface FileChild extends DirChild {
  size: number; // bytes
  ext: string; // lowercase, no dot; "" for extensionless files
}

export interface DirContents {
  path: string;
  parent: string | null;
  dirs: DirChild[];
  images: ImageChild[];
  sidecars: SidecarChild[];
  /** Non-image, non-sidecar regular files (incl. video and extensionless
   *  files). Surfaced so the File Provider can sync every file type; never
   *  carries an asset id. */
  files: FileChild[];
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

/** A directory that resolved inside the jail, and what it holds. */
interface OpenedDirectory {
  /** The symlink-resolved path. Every child is re-checked against it. */
  real: string;
  /** The jail this listing was allowed through. */
  roots: string[];
  /** Raw entry names, as `readdir` gave them. */
  names: string[];
  /** The names a listing may show, sorted: no dotfiles, no `.hidden` markers. */
  visible: string[];
}

/**
 * Resolves a request path, confirms it is inside the jail, and reads it.
 *
 * The two listing endpoints open identically and jail against different root
 * sets — the browse roots for one, the File Provider's for the other — so the
 * root loader is the argument rather than a copy of the four checks.
 *
 * Each failure keeps the message it had: the three of them name the path the
 * caller asked for, which is what makes a listing failure diagnosable from the
 * response alone.
 */
async function openDirectory(
  reqPath: string,
  loadRoots: () => Promise<string[]>,
): Promise<OpenedDirectory | { ok: false; error: string }> {
  if (!path.isAbsolute(reqPath)) return { ok: false, error: 'Path must be absolute.' };

  const real = await realpath(reqPath).catch((err: unknown) => err);
  if (typeof real !== 'string') {
    return { ok: false, error: `Cannot access "${reqPath}": ${errorText(real)}` };
  }

  const roots = await loadRoots();
  if (!roots.some((r) => isUnderRoot(real, r))) {
    return { ok: false, error: `Path "${real}" is outside MAPLE_ROOTS [${roots.join(', ')}]` };
  }

  const names = await readdir(real).catch((err: unknown) => err);
  if (!Array.isArray(names)) {
    return { ok: false, error: `Cannot list "${real}": ${errorText(names)}` };
  }
  const visible = names
    .filter((n: string) => !n.startsWith('.') && !n.endsWith('.hidden'))
    .sort((a: string, b: string) => a.localeCompare(b));
  return { real, roots, names, visible };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The page of `visible` this request asked for, or the cursor's complaint. */
interface PageWindow {
  /** False when neither `cursor` nor `limit` was sent: one shot, no slicing. */
  pagedMode: boolean;
  slice: string[];
  /** Where the next page starts, or null when this one ends the listing. */
  nextOffset: number | null;
}

/**
 * Slices a sorted listing into the page the caller asked for.
 *
 * Both listing endpoints page identically and differed only in how they
 * rendered the same failure — one of them also re-checked an upper bound on
 * the offset, which `decodeCursor` has already refused by the time the check
 * could run.
 *
 * With neither `cursor` nor `limit` the result is the whole listing and a null
 * next offset, which is the unpaged behaviour both endpoints kept.
 */
function pageWindow(
  visible: string[],
  opts: { cursor?: string; limit?: number },
): PageWindow | { ok: false; error: string } {
  const pagedMode = opts.cursor !== undefined || opts.limit !== undefined;
  const decoded = decodeOffset(opts.cursor);
  if (typeof decoded !== 'number') return decoded;
  const limit = pagedMode ? Math.max(1, Math.min(2000, opts.limit ?? 500)) : visible.length;
  return {
    pagedMode,
    slice: pagedMode ? visible.slice(decoded, decoded + limit) : visible,
    nextOffset: pagedMode && decoded + limit < visible.length ? decoded + limit : null,
  };
}

/** The offset a cursor carries, 0 when there is none, or the complaint. */
function decodeOffset(cursor: string | undefined): number | { ok: false; error: string } {
  if (cursor === undefined) return 0;
  try {
    return decodeCursor(cursor);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List a single directory level: subdirectories + image files.
 *
 * - Hides dotfiles/dotdirs (including the `.maple/` cache dir).
 * - Filters images to IMAGE_EXTENSIONS — RAWs + the bitmap formats the thumb
 *   endpoint can render (case-insensitive).
 * - Enforces the MAPLE_ROOTS + registered-library jail, including a per-child
 *   realpath re-check so a symlink swap can't escape the jail. Registered
 *   roots are included because this endpoint is the Apple File Provider's
 *   listing path after `/api/folders` advertises those roots.
 * - Does NOT recurse.
 */
export async function listDirContents(
  reqPath: string,
  opts: ListDirOptions = {},
): Promise<OpResult<DirContents>> {
  const opened = await openDirectory(reqPath, fileProviderBrowseRoots);
  if ('error' in opened) return opened;
  const { real, roots, visible } = opened;

  // Paging window. cursor === undefined AND limit === undefined keeps
  // the historical single-shot behaviour (no slicing, no next_cursor).
  // Any cursor OR limit query param triggers paged mode.
  const window = pageWindow(visible, opts);
  if ('error' in window) return window;
  const { pagedMode, slice, nextOffset } = window;

  // ── Cross-page sidecar pairing (issue #6 of PR #66 review) ─────────
  // Sidecars are paired to images by canonical filename base. When the
  // visible list is sliced, an image and its `.xmp` sidecar can land on
  // different pages — and the sidecar would be silently dropped because
  // `imageBaseToAsset` was built only from the current slice's images.
  //
  // Fix: in paged mode, pre-walk ALL visible image filenames (cheap —
  // just an extension test + path join, no realpath/stat) and look up
  // the full set of indexed asset IDs in one batched query. That
  // map is then consulted by the per-slice sidecar loop below so a
  // sidecar resolves its assetID regardless of which page its paired
  // image fell on. In unpaged mode the slice == visible, so the global
  // map collapses to the legacy behaviour.
  const globalImageBaseToAsset = new Map<string, string>();
  if (pagedMode) {
    const allImageBases = new Map<string, string>(); // base → candidate abs_path
    for (const name of visible) {
      const dot = name.lastIndexOf('.');
      if (dot < 0) continue;
      const ext = name.slice(dot + 1).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        const base = name.slice(0, dot);
        const candidate = real === '/' ? '/' + name : `${real}/${name}`;
        allImageBases.set(base, candidate);
      } else if (VIDEO_EXTENSIONS.has(ext)) {
        // Video sidecar convention: full-name key (clip.mov → clip.mov.xmp → base 'clip.mov')
        const candidate = real === '/' ? '/' + name : `${real}/${name}`;
        allImageBases.set(name, candidate);
      }
    }
    if (allImageBases.size > 0) {
      try {
        // Query by filename via the locations table. The legacy `abs_path`
        // field was retired in the drop-abs-path-2026-05-21 migration; we
        // resolve each hit's on-disk path from `assetAbsPath(doc, libs)` and
        // match against the candidate paths in code.
        const libs = await loadLibraryRoots().catch(() => new Map<string, string>());
        const filenames = new Set<string>();
        for (const [, p] of allImageBases) filenames.add(p.split('/').pop()!);
        const docs = await findListingAssetsByFilenames(Array.from(filenames));
        const pathToBase = new Map<string, string>();
        for (const [b, p] of allImageBases) pathToBase.set(p, b);
        for (const doc of docs) {
          const resolved = assetAbsPath(doc, libs);
          if (!resolved) continue;
          const b = pathToBase.get(resolved);
          if (b) globalImageBaseToAsset.set(b, doc._id.toHexString());
        }
      } catch (err) {
        // Best-effort — same posture as the EXIF enrichment below.
        log.error(
          { real, err: err instanceof Error ? err.message : err },
          'global image-base lookup failed',
        );
      }
    }
  }

  const dirs: DirChild[] = [];
  const images: ImageChild[] = [];
  const files: FileChild[] = [];
  // `SidecarChild` keys are snake_case (`asset_id`); the original
  // `Omit<…, "assetID">` was a no-op typo that left `sidecarRaw`
  // effectively typed as `SidecarChild[]`, making the literal pushed
  // below (without `asset_id`) invalid under strict TS.
  const sidecarRaw: Array<Omit<SidecarChild, 'asset_id'>> = [];

  const results = await scanChildren(slice, real, roots);

  for (const r of results) {
    if (!r) continue;
    const { name, path: childReal, st } = r;

    if (st.isDirectory()) {
      dirs.push({ name, path: childReal, mtime: st.mtime.toISOString() });
    } else if (st.isFile()) {
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
      if (ext !== '' && isListableMediaExt(ext)) {
        images.push(buildMediaListItem(name, childReal, st, ext));
      } else if (ext === 'xmp') {
        sidecarRaw.push({
          name,
          path: childReal,
          size: st.size,
          mtime: st.mtime.toISOString(),
        });
      } else {
        // Every other regular file (documents, archives, extensionless) —
        // stored + synced but never indexed.
        files.push({
          name,
          path: childReal,
          size: st.size,
          mtime: st.mtime.toISOString(),
          ext,
        });
      }
    }
  }

  // Bulk-attach indexed EXIF for the images in this listing. One batched
  // lookup rather than per-image queries. If the indexer hasn't touched this
  // folder yet, it returns nothing and `exif` stays undefined on each entry —
  // the client renders "—" gracefully.
  const indexedPaths = new Set<string>();
  const trashedPaths = new Set<string>();
  if (images.length > 0) {
    try {
      const libs = await loadLibraryRoots().catch(() => new Map<string, string>());
      const imageFilenames = new Set(images.map((i) => i.path.split('/').pop()!));
      const docs = await findListingAssetsByFilenames(Array.from(imageFilenames));
      const byPath = new Map<string, { id: string; exif: AssetExif | null | undefined }>();
      for (const doc of docs) {
        const resolved = assetAbsPath(doc, libs);
        if (!resolved) continue;
        // Files whose asset row is soft-deleted must not appear under their
        // pre-trash directory listing — the file has either moved to
        // .maple/trash/<rel> (File-Provider DELETE) or vanished from disk
        // (watcher); either way, hiding it from /api/fs/dir matches what
        // the user expects after a delete.
        if (doc.deleted_at != null) {
          trashedPaths.add(resolved);
          continue;
        }
        byPath.set(resolved, { id: doc._id.toHexString(), exif: doc.exif });
        indexedPaths.add(resolved);
      }
      for (const img of images) {
        const hit = byPath.get(img.path);
        if (hit) {
          img.id = hit.id;
          img.exif = hit.exif;
        }
      }
    } catch (err) {
      // EXIF enrichment is best-effort — a DB hiccup shouldn't break browse.
      log.error({ real, err: err instanceof Error ? err.message : err }, 'exif lookup failed');
    }
  }
  // Drop trashed-on-disk files so they don't appear in the listing.
  if (trashedPaths.size > 0) {
    for (let i = images.length - 1; i >= 0; i--) {
      if (trashedPaths.has(images[i]!.path)) images.splice(i, 1);
    }
  }

  // Pair each candidate sidecar to an indexed asset by matching the
  // canonical base (strip ".xmp" and optional "(conflict from …)"
  // suffix) against the filename base of an indexed image. In paged
  // mode we consult the dir-wide map computed above so a sidecar can
  // pair to its image even when paging split them across two responses.
  // In unpaged mode the per-slice map is sufficient.
  const imageBaseToAsset = new Map<string, string>(globalImageBaseToAsset);
  for (const img of images) {
    if (!img.id) continue;
    if (img.isVideo) {
      // Video: sidecar convention is full-name (clip.mov → clip.mov.xmp).
      // canonicalBaseFromSidecarFilename('clip.mov.xmp') returns 'clip.mov',
      // so key by full filename.
      imageBaseToAsset.set(img.name, img.id);
    } else {
      const dot = img.name.lastIndexOf('.');
      const base = dot >= 0 ? img.name.slice(0, dot) : img.name;
      imageBaseToAsset.set(base, img.id);
    }
  }

  const sidecars: SidecarChild[] = [];
  for (const cand of sidecarRaw) {
    const base = canonicalBaseFromSidecarFilename(cand.name);
    if (!base) continue;
    // No longer skip video-named bases — video assets are now indexed and
    // their sidecars (clip.mov.xmp → base 'clip.mov') must be paired.
    const assetID = imageBaseToAsset.get(base);
    if (!assetID) continue;
    sidecars.push({ ...cand, asset_id: assetID });
  }

  // Fire-and-forget: index any RAW images in this listing that don't have
  // an asset doc yet. Skips the thumb stage — `/api/fs/thumb` already
  // renders thumbs lazily, so re-doing the work in the indexer would
  // waste the FFI worker pool. Best-effort: a missing folder ancestor
  // or a down indexer child both quietly no-op.
  if (images.length > 0) {
    const unindexed = images.filter((i) => !indexedPaths.has(i.path)).map((i) => i.path);
    if (unindexed.length > 0) {
      void enqueueBrowseIndex(real, unindexed).catch((err) =>
        log.warn(
          { real, err: err instanceof Error ? err.message : err },
          'enqueue browse index failed',
        ),
      );
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
      sidecars,
      files,
      ...(nextOffset !== null ? { next_cursor: encodeCursor(nextOffset) } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// listDirFast — used by GET /api/fs/dir-fast.
//
// Pure-filesystem variant of `listDirContents`: readdir + realpath + stat,
// nothing else. No database queries, no EXIF lookup, no trash hiding, no
// sidecar pairing, no discover enqueue. Designed for the web Browse grid,
// which doesn't need any of those — per-image badges (rating / flag / has-
// edits / EXIF) live in the search/timeline grid, and the editor's cold-
// load path keys assets by `fs:${abs_path}` so it doesn't need a stable
// database id either.
//
// The Apple File Provider extension and the iOS/macOS cloud-source browse
// continue to use `/api/fs/dir`, which preserves the enriched response
// they depend on (assetID-keyed FP items, paired sidecars, etc).
// ---------------------------------------------------------------------------

export interface FastImageChild extends DirChild {
  size: number; // bytes
  ext: string; // lowercase, no dot
  /** True when the file is a video container (e.g. .mov, .mp4). */
  isVideo?: true;
  /** True when the file is a metadata-only stub image with no decoder (e.g.
   * .eip, .braw, .afphoto, .ai). See #1835. */
  isStub?: true;
  /** True when the file is an audio format (e.g. .mp3, .wav, .m4a, .aac).
   * See #1835. */
  isAudio?: true;
}

export interface FastDirContents {
  path: string;
  parent: string | null;
  dirs: DirChild[];
  images: FastImageChild[];
  next_cursor?: string;
}

/** One surviving child of a listing: it resolved, and it is inside the jail. */
interface ScannedEntry {
  name: string;
  path: string;
  st: Stats;
}

/**
 * Resolves and stats every name in a page, dropping the ones a listing must
 * not show.
 *
 * The realpath re-check per child is the symlink-swap defence: the directory
 * passed the jail, but a child could be a symlink pointing out of it, and a
 * listing that trusted the parent's verdict would hand out a path outside
 * every root. A null is that, a broken symlink, a permission denial, or a file
 * that vanished between the readdir and the stat — all four mean the same
 * thing to a caller, which is that there is nothing here to list.
 */
async function scanChildren(
  slice: readonly string[],
  real: string,
  roots: readonly string[],
): Promise<Array<ScannedEntry | null>> {
  return Promise.all(
    slice.map(async (name) => {
      const childCandidate = real === '/' ? '/' + name : `${real}/${name}`;
      const childReal = await realpath(childCandidate).catch(() => null);
      if (childReal === null) return null;
      if (!roots.some((r) => isUnderRoot(childReal, r))) return null;
      const st = await stat(childReal).catch(() => null);
      return st === null ? null : { name, path: childReal, st };
    }),
  );
}

/**
 * Sorts scanned children into the two lists the fast listing answers with.
 *
 * Anything that is neither a directory nor a listable media file is dropped —
 * including a file with no extension, which cannot be classified and is not
 * something this endpoint offers. A null entry is a child that vanished or
 * left the jail between the readdir and the stat.
 */
function splitEntries(entries: ReadonlyArray<ScannedEntry | null>): {
  dirs: DirChild[];
  images: FastImageChild[];
} {
  const dirs: DirChild[] = [];
  const images: FastImageChild[] = [];
  for (const entry of entries) {
    if (entry === null) continue;
    const { name, path: childReal, st } = entry;
    if (st.isDirectory()) {
      dirs.push({ name, path: childReal, mtime: st.mtime.toISOString() });
      continue;
    }
    const ext = listableExt(name, st);
    if (ext !== null) images.push(buildMediaListItem(name, childReal, st, ext));
  }
  return { dirs, images };
}

/** The extension this entry should be listed under, or null for "not listed". */
function listableExt(name: string, st: Stats): string | null {
  if (!st.isFile()) return null;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return isListableMediaExt(ext) ? ext : null;
}

export async function listDirFast(
  reqPath: string,
  opts: ListDirOptions = {},
): Promise<OpResult<FastDirContents>> {
  const opened = await openDirectory(reqPath, browseRoots);
  if ('error' in opened) return opened;
  const { real, roots } = opened;
  // This endpoint does not surface `.xmp` sidecars, and they should not pay
  // the realpath+stat cost per entry, so they come out before paging.
  const visible = opened.visible.filter((n) => !n.toLowerCase().endsWith('.xmp'));

  const window = pageWindow(visible, opts);
  if ('error' in window) return window;
  const { slice, nextOffset } = window;

  const results = await scanChildren(slice, real, roots);

  const { dirs, images } = splitEntries(results);

  const isRoot = real === '/';
  return {
    ok: true,
    data: {
      path: real,
      parent: isRoot ? null : path.dirname(real),
      dirs,
      images,
      ...(nextOffset !== null ? { next_cursor: encodeCursor(nextOffset) } : {}),
    },
  };
}

/**
 * Find the deepest registered folder whose `path` is an ancestor of
 * `absPath` (inclusive). Returns the folder's hex `_id` and its library
 * root path, or `null` if `absPath` is not under any registered folder.
 * The set of folders is small (one per library root the user has
 * registered) so a full scan here is fine.
 *
 * The returned `root` is passed straight through to `handleEvent` so the
 * discover producer doesn't pay a second database round-trip per file.
 */
async function findOwningFolder(absPath: string): Promise<{ id: string; root: string } | null> {
  const folders = await listFolders();
  let best: { id: string; root: string } | null = null;
  let bestLen = -1;
  for (const f of folders) {
    if (absPath === f.path || absPath.startsWith(f.path + '/')) {
      if (f.path.length > bestLen) {
        bestLen = f.path.length;
        best = { id: f._id.toHexString(), root: f.path };
      }
    }
  }
  return best;
}

/**
 * Push a batch of un-indexed paths into the discover producer via handleEvent.
 *
 * Calls handleEvent({ kind: "created", absPath }, folderId) for each path that
 * is not yet in the `assets` table. This is a fire-and-forget operation —
 * the caller does not wait for upserts to complete. A failed upsert is logged
 * as a warning and does not surface to the HTTP response.
 *
 * If no owning folder is found for a path (the folder has not been registered
 * yet), the path is skipped silently — it will be picked up once the folder is
 * registered and discover starts watching it.
 */
async function enqueueBrowseIndex(dirPath: string, paths: string[]): Promise<void> {
  const { handleEvent } = await import('../workers/discover/index.ts');
  const { ObjectId } = await import('mongodb');

  const folder = await findOwningFolder(dirPath);
  if (!folder) {
    log.debug(
      { dirPath, count: paths.length },
      'enqueueBrowseIndex: no owning folder found — skipping',
    );
    return;
  }

  const folderObjectId = new ObjectId(folder.id);
  for (const absPath of paths) {
    handleEvent({ kind: 'created', absPath }, folderObjectId, folder.root).catch((err) =>
      log.warn(
        { absPath, err: err instanceof Error ? err.message : err },
        'enqueueBrowseIndex: handleEvent failed',
      ),
    );
  }

  log.debug({ dirPath, count: paths.length, folderId: folder.id }, 'enqueueBrowseIndex: fired');
}
