// src/api/src/fs/browse.ts
//
// Filesystem browse helper for the library-picker UI.
//
// Lists subdirectories under a path with a `MAPLE_ROOTS` jail (default '/')
// and a system-directory denylist that hides /proc, /etc, /usr, /app, ... at
// the filesystem root unless `showAll` is true.

import { readdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import type { OpResult } from "./root.ts";
import { assetsCollection, foldersCollection } from "../db/client.ts";
import type { AssetExif } from "../db/schema.ts";
import { SHARP_EXTENSIONS } from "../thumbs/render.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("fs/browse");

export interface DirEntry {
  name: string;
  path: string;       // absolute, symlink-resolved
  hasChildren: boolean;
}

export interface DirListing {
  path: string;       // absolute, symlink-resolved
  parent: string | null;
  entries: DirEntry[];
}

/** Linux/macOS directory names hidden at the filesystem root unless showAll=1. */
export const SYSTEM_DIRS = new Set<string>([
  "proc", "sys", "dev", "run", "boot",
  "bin", "sbin", "lib", "lib32", "lib64",
  "usr", "etc", "var", "tmp",
  "root", "opt", "srv",
  "private",  // macOS
  "app",      // container working dir
  "node_modules",
]);

export async function browseRoots(): Promise<string[]> {
  const env = process.env.MAPLE_ROOTS;
  if (!env || env.trim() === "") return ["/"];
  // Strip trailing slash unless the entry IS just "/" — `"/".replace(/\/$/, "")`
  // collapses to "" and then filter(Boolean) drops it, leaving an empty roots
  // list for `MAPLE_ROOTS=/`. Preserve "/" explicitly.
  const raw = env
    .split(":")
    .map((p) => (p === "/" ? "/" : p.replace(/\/$/, "")))
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
  const r = root.replace(/\/$/, "") || "/";
  if (r === "/") return true;
  return absPath === r || absPath.startsWith(r + "/");
}

export async function listDir(
  reqPath: string,
  showAll: boolean,
): Promise<OpResult<DirListing>> {
  if (!path.isAbsolute(reqPath)) {
    return { ok: false, error: "Path must be absolute." };
  }

  let real: string;
  try {
    real = await realpath(reqPath);
  } catch (err) {
    return { ok: false, error: `Cannot access "${reqPath}": ${err instanceof Error ? err.message : String(err)}` };
  }

  const roots = await browseRoots();
  if (!roots.some((r) => isUnderRoot(real, r))) {
    return {
      ok: false,
      error: `Path "${real}" is outside MAPLE_ROOTS [${roots.join(", ")}]`,
    };
  }

  let rawEntries: { name: string }[];
  try {
    rawEntries = await readdir(real, { withFileTypes: false }).then(
      (names) => names.map((n) => ({ name: n })),
    );
  } catch (err) {
    return { ok: false, error: `Cannot list "${real}": ${err instanceof Error ? err.message : String(err)}` };
  }

  const atRoot = real === "/";

  // Pre-filter by name (hidden files, system dirs at root) before the
  // per-entry async work so we skip obviously unwanted entries cheaply.
  const candidates = rawEntries
    .filter((e) => !e.name.startsWith("."))
    .filter((e) => showAll || !atRoot || !SYSTEM_DIRS.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const out: DirEntry[] = [];
  for (const e of candidates) {
    const childCandidate = real === "/" ? "/" + e.name : `${real}/${e.name}`;

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
        (s) => !s.name.startsWith(".") && (s.isDirectory() || s.isSymbolicLink()),
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
  const isRoot = real === "/";
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
  "cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2", "pef", "srw",
]);

/** All image extensions surfaced by the directory listing. Union of RAWs
 * (decoded via FFI) and bitmap formats (decoded via sharp/heic-convert).
 * Kept in sync with the thumb endpoint's extension gate. */
const IMAGE_EXTENSIONS = new Set<string>([
  ...RAW_EXTENSIONS,
  ...SHARP_EXTENSIONS,
]);

export interface DirChild {
  name: string;
  path: string;       // absolute, symlink-resolved
  mtime: string;      // ISO-8601
}

export interface ImageChild extends DirChild {
  size: number;       // bytes
  ext: string;        // lowercase, no dot
  /**
   * Indexed EXIF for this RAW (camera/lens/exposure/captured_at/gps), looked
   * up by `abs_path` against the `assets` collection. `null` when the indexer
   * processed this file but found no usable EXIF; `undefined` when the file
   * hasn't been indexed yet (or the indexer hasn't run for this folder).
   */
  exif?: AssetExif | null;
}

export interface DirContents {
  path: string;
  parent: string | null;
  dirs: DirChild[];
  images: ImageChild[];
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
): Promise<OpResult<DirContents>> {
  if (!path.isAbsolute(reqPath)) {
    return { ok: false, error: "Path must be absolute." };
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
      error: `Path "${real}" is outside MAPLE_ROOTS [${roots.join(", ")}]`,
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

  const visible = names.filter((n) => !n.startsWith(".")).sort((a, b) =>
    a.localeCompare(b),
  );

  const dirs: DirChild[] = [];
  const images: ImageChild[] = [];

  for (const name of visible) {
    const childCandidate = real === "/" ? "/" + name : `${real}/${name}`;

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
      const dot = name.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = name.slice(dot + 1).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      images.push({
        name,
        path: childReal,
        size: st.size,
        mtime: st.mtime.toISOString(),
        ext,
      });
    }
  }

  // Bulk-attach indexed EXIF for the images in this listing. Single round-
  // trip with `$in` rather than per-image lookups. If the indexer hasn't
  // touched this folder yet, the find returns nothing and `exif` stays
  // undefined on each entry — the client renders "—" gracefully.
  const indexedPaths = new Set<string>();
  if (images.length > 0) {
    try {
      const coll = await assetsCollection();
      const cursor = coll.find(
        { abs_path: { $in: images.map((i) => i.path) } },
        { projection: { abs_path: 1, exif: 1 } },
      );
      const byPath = new Map<string, AssetExif | null | undefined>();
      for await (const doc of cursor) {
        byPath.set(doc.abs_path, doc.exif);
        indexedPaths.add(doc.abs_path);
      }
      for (const img of images) {
        if (byPath.has(img.path)) img.exif = byPath.get(img.path);
      }
    } catch (err) {
      // EXIF enrichment is best-effort — a DB hiccup shouldn't break browse.
      log.error(
        { real, err: err instanceof Error ? err.message : err },
        "exif lookup failed",
      );
    }
  }

  // Fire-and-forget: index any RAW images in this listing that don't have
  // an asset doc yet. Skips the thumb stage — `/api/fs/thumb` already
  // renders thumbs lazily, so re-doing the work in the indexer would
  // waste the FFI worker pool. Best-effort: a missing folder ancestor
  // or a down indexer child both quietly no-op.
  if (images.length > 0) {
    const unindexed = images
      .filter((i) => !indexedPaths.has(i.path))
      .map((i) => i.path);
    if (unindexed.length > 0) {
      void enqueueBrowseIndex(real, unindexed).catch((err) =>
        log.warn(
          { real, err: err instanceof Error ? err.message : err },
          "enqueue browse index failed",
        ),
      );
    }
  }

  const isRoot = real === "/";
  return {
    ok: true,
    data: {
      path: real,
      parent: isRoot ? null : path.dirname(real),
      dirs,
      images,
    },
  };
}

/**
 * Find the deepest registered folder whose `path` is an ancestor of
 * `absPath` (inclusive). Returns the folder's hex `_id`, or `null` if
 * `absPath` is not under any registered folder. The set of folders is
 * small (one per library root the user has registered) so a full scan
 * here is fine.
 */
async function findOwningFolderId(absPath: string): Promise<string | null> {
  const coll = await foldersCollection();
  const folders = await coll.find({}).toArray();
  let bestId: string | null = null;
  let bestLen = -1;
  for (const f of folders) {
    if (absPath === f.path || absPath.startsWith(f.path + "/")) {
      if (f.path.length > bestLen) {
        bestLen = f.path.length;
        bestId = f._id.toHexString();
      }
    }
  }
  return bestId;
}

/**
 * Push a batch of un-indexed paths into the discover producer via handleEvent.
 *
 * Calls handleEvent({ kind: "created", absPath }, folderId) for each path that
 * is not yet in the assets collection. This is a fire-and-forget operation —
 * the caller does not wait for upserts to complete. A failed upsert is logged
 * as a warning and does not surface to the HTTP response.
 *
 * If no owning folder is found for a path (the folder has not been registered
 * yet), the path is skipped silently — it will be picked up once the folder is
 * registered and discover starts watching it.
 */
async function enqueueBrowseIndex(
  dirPath: string,
  paths: string[],
): Promise<void> {
  const { handleEvent } = await import("../workers/discover/index.ts");
  const { ObjectId } = await import("mongodb");

  const folderId = await findOwningFolderId(dirPath);
  if (!folderId) {
    log.debug(
      { dirPath, count: paths.length },
      "enqueueBrowseIndex: no owning folder found — skipping",
    );
    return;
  }

  const folderObjectId = new ObjectId(folderId);
  for (const absPath of paths) {
    handleEvent({ kind: "created", absPath }, folderObjectId).catch((err) =>
      log.warn(
        { absPath, err: err instanceof Error ? err.message : err },
        "enqueueBrowseIndex: handleEvent failed",
      ),
    );
  }

  log.debug(
    { dirPath, count: paths.length, folderId },
    "enqueueBrowseIndex: fired",
  );
}
