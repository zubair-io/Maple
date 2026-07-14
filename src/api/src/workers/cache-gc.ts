/**
 * Cache GC — sweep orphaned `.maple/{thumbs,previews}/*.{jpg,avif,json}` files.
 *
 * Walks a library root looking for `.maple/thumbs` and `.maple/previews`
 * directories. Thumbs and previews now use TWO DIFFERENT orphan-detection
 * schemes, since previews dropped content-addressing (see
 * `cachePathForAsset`'s doc in `fs/xmp.ts`):
 *
 *   - `thumbs` stays `maple_id`-keyed (`<maple_id>.avif`, `.jpg` for legacy
 *     pre-v3 orphans): a file is orphaned when its `maple_id` isn't in the
 *     `known` set built once from the whole `assets` collection (a
 *     `maple_id` is unique DB-wide, so this needs no per-library scoping).
 *   - `previews` is path-keyed (`<filename>.<suffix>`, any of `.avif`/`.jpg`/
 *     `.json`): a file is orphaned when its filename isn't a live location
 *     in THIS library at THIS exact directory. Since previews no longer
 *     survive a rename/move by design, this sweep is now mostly a BACKSTOP —
 *     the primary cleanup happens synchronously wherever a `fileinfo` entry
 *     is removed (`cleanPreviewsCacheForLocation`, called from
 *     `missing-reaper.ts`/`dedupe.ts`) — for whatever that missed (a crash
 *     mid-cleanup, files present before this backstop ever ran).
 *
 * No migration sentinel:
 *   The set of orphans changes continuously (a re-render at a new size, a
 *   rename, a hard-delete each create one). A one-shot sentinel-gated sweep
 *   would miss every orphan produced after the sentinel was recorded.
 *   Instead, the supervisor calls `sweepOrphanedCaches` once at boot per
 *   registered library as a fire-and-forget background task. Bounded work:
 *   each sweep is O(files-in-library).
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ObjectId } from "mongodb";
import { assetsCollection } from "../db/client.ts";
import { loadLibraryRoots } from "../indexer/libraries.cache.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("cache-gc");

export interface SweepResult {
  scanned: number;
  deleted: number;
  skipped_recent: number;
}

/** Minimal projected shape of one `fileinfo` entry, for the previews
 * known-live-set query below. */
interface FileInfoLocation {
  library_id: ObjectId;
  path: string;
  filename: string;
  deleted_at?: unknown;
  missing_since?: unknown;
}

/**
 * Files written within this window are assumed mid-write or just-written by a
 * concurrent stage. Skip them this pass — the next boot's sweep will catch
 * them if they're genuinely orphaned. Cheapest defense against the TOCTOU
 * race where `known` is snapshotted before a stage finishes writing a fresh
 * `<maple_id>.avif`.
 */
const RECENT_THRESHOLD_MS = 60 * 1000;

/**
 * Abort the sweep after this many consecutive same-errno unlink failures.
 * EACCES / EROFS / EBUSY signal an operator-level config problem (mount
 * read-only, perms wrong, busy by another process) — no point continuing
 * to retry across thousands of files for noise we can't fix from here.
 */
const FAIL_THRESHOLD = 3;

/**
 * Matches `<maple_id>` (32 lowercase hex), thumbs-only now that previews
 * dropped content-addressing (see this file's module doc). The legacy
 * `sha256_prefix16` cache key is 16 hex chars and does NOT match — it falls
 * through to the "unknown shape, unlink" branch. The trailing optional
 * suffix group is dead for thumbs' actual naming (`<maple_id>.avif`, no
 * suffix) but kept harmless/permissive rather than tightened without a
 * concrete need to.
 */
const MAPLE_ID_RE = /^[0-9a-f]{32}(?:_[a-z0-9_]+)?$/;

/** Resolve `libraryRoot`'s registered `_id`, or `null` if it isn't a
 * registered library root (or the lookup fails). `null` makes the previews
 * sweep scan/count as normal but skip every delete decision (see
 * `sweepPreviewsDir`) rather than treat an empty known-live set as "nothing
 * is live" — a transient failure here must never cause a mass-delete of
 * live previews. */
async function resolveLibraryId(libraryRoot: string): Promise<ObjectId | null> {
  try {
    const libs = await loadLibraryRoots();
    for (const [idHex, root] of libs) {
      if (root === libraryRoot) return new ObjectId(idHex);
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

export async function sweepOrphanedCaches(
  libraryRoot: string,
): Promise<SweepResult> {
  // Build the set of known maple_ids once (one query, DB-wide — a maple_id
  // is unique regardless of which library it lives in). Projection keeps the
  // working set tight even on 100k-asset libraries; iterating the cursor
  // avoids materialising the full result array as an intermediate.
  const coll = await assetsCollection();
  const knownMapleIds = new Set<string>();
  const mapleIdCursor = coll.find(
    { maple_id: { $type: "string" } },
    { projection: { maple_id: 1 } },
  );
  for await (const doc of mapleIdCursor) {
    if (typeof doc.maple_id === "string") knownMapleIds.add(doc.maple_id);
  }

  // Build the set of live (path, filename) pairs for THIS library only —
  // previews are path-keyed per-location, not DB-wide unique like maple_id,
  // so this needs library scoping. `path` (POSIX-separated, matching
  // `fileinfo.path`'s own convention) maps to the set of live filenames at
  // that exact directory.
  const knownPreviewFilenames = new Map<string, Set<string>>();
  const libraryId = await resolveLibraryId(libraryRoot);
  if (libraryId) {
    const fiCursor = coll.find(
      {
        fileinfo: {
          $elemMatch: {
            library_id: libraryId,
            deleted_at: null,
            missing_since: null,
          },
        },
      },
      { projection: { fileinfo: 1 } },
    );
    for await (const doc of fiCursor) {
      for (const fi of (doc.fileinfo as FileInfoLocation[] | undefined) ?? []) {
        if (
          !fi.library_id.equals(libraryId) ||
          fi.deleted_at ||
          fi.missing_since
        )
          continue;
        const set = knownPreviewFilenames.get(fi.path) ?? new Set<string>();
        set.add(fi.filename);
        knownPreviewFilenames.set(fi.path, set);
      }
    }
  }

  let scanned = 0;
  let deleted = 0;
  let skippedRecent = 0;
  const now = Date.now();

  let recentFailErrno: string | null = null;
  let recentFailCount = 0;

  async function walk(dir: string, relDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip symlinks defensively — with `withFileTypes: true`, a symlink
      // entry has `isSymbolicLink() === true` and `isDirectory() === false`
      // (the dirent reflects lstat, not stat). Without this guard, a future
      // change that resolves the target before classification could let a
      // self-referential or upward-pointing dir symlink loop the walk forever.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".maple") {
          await sweepThumbsDir(path.join(full, "thumbs"));
          await sweepPreviewsDir(path.join(full, "previews"), relDir);
        } else if (!entry.name.startsWith(".")) {
          const childRelDir =
            relDir === "" ? entry.name : `${relDir}/${entry.name}`;
          await walk(full, childRelDir);
        }
      }
    }
  }

  async function sweepThumbsDir(cacheDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = (await fs.readdir(cacheDir, {
        withFileTypes: true,
      })) as Dirent[];
    } catch {
      return; // ENOENT — fine, no cache here.
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (ext !== ".jpg" && ext !== ".avif") continue;
      scanned += 1;
      const stem = entry.name.slice(0, -ext.length);
      const fullPath = path.join(cacheDir, entry.name);

      // TOCTOU defense: `knownMapleIds` was snapshotted before this walk
      // began. A stage may have written this file in the meantime. If the
      // file's mtime is within the recency window, defer to the next boot's
      // sweep.
      const stat = await fs.stat(fullPath).catch(() => null);
      if (stat && now - stat.mtimeMs < RECENT_THRESHOLD_MS) {
        skippedRecent += 1;
        continue;
      }

      if (!MAPLE_ID_RE.test(stem)) {
        // basename isn't shaped like a maple_id (e.g. legacy 16-hex
        // sha256_prefix16 key). Definitely orphaned.
        if (await unlinkSafe(fullPath)) deleted += 1;
        continue;
      }
      // Stem is `<maple_id>` (thumbs ignore size — one file per asset).
      const mapleId = stem.slice(0, 32);
      if (!knownMapleIds.has(mapleId)) {
        if (await unlinkSafe(fullPath)) deleted += 1;
      }
    }
  }

  /** Previews orphan sweep — mostly a backstop now (see module doc): the
   * primary cleanup is synchronous, at the point a `fileinfo` entry is
   * removed. A file is orphaned when its name isn't `<live filename>.<...>`
   * for any currently-live filename at this exact directory. */
  async function sweepPreviewsDir(
    cacheDir: string,
    relDir: string,
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = (await fs.readdir(cacheDir, {
        withFileTypes: true,
      })) as Dirent[];
    } catch {
      return; // ENOENT — fine, no cache here.
    }
    const liveNames = knownPreviewFilenames.get(relDir) ?? new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (ext !== ".jpg" && ext !== ".avif" && ext !== ".json") continue;
      scanned += 1;
      const fullPath = path.join(cacheDir, entry.name);

      // TOCTOU defense — same rationale as the thumbs sweep above.
      const stat = await fs.stat(fullPath).catch(() => null);
      if (stat && now - stat.mtimeMs < RECENT_THRESHOLD_MS) {
        skippedRecent += 1;
        continue;
      }

      // No resolvable library id → no known-live set was (or safely could
      // be) built for THIS pass. Never delete without one — a transient
      // failure to resolve the library must not mass-delete live previews
      // (see `resolveLibraryId`) — but still scan/count, matching thumbs.
      if (!libraryId) continue;

      const isLive = [...liveNames].some((name) =>
        entry.name.startsWith(`${name}.`),
      );
      if (!isLive) {
        if (await unlinkSafe(fullPath)) deleted += 1;
      }
    }
  }

  async function unlinkSafe(p: string): Promise<boolean> {
    try {
      await fs.unlink(p);
      recentFailCount = 0;
      recentFailErrno = null;
      return true;
    } catch (err) {
      const errno = (err as { code?: string } | null)?.code ?? "UNKNOWN";
      if (errno === "ENOENT") {
        // Race: file vanished between readdir/stat and unlink (another
        // process, or a stage cleaning up its own artefact). The desired
        // state — file gone — is achieved, so don't count this toward the
        // failure threshold and don't log noise. Reset the streak just like
        // the success path so a real EACCES burst stays isolated.
        recentFailCount = 0;
        recentFailErrno = null;
        return false;
      }
      if (errno === recentFailErrno) {
        recentFailCount += 1;
      } else {
        recentFailErrno = errno;
        recentFailCount = 1;
      }
      log.warn(
        { p, errno, err: err instanceof Error ? err.message : err },
        "unlink failed",
      );
      if (recentFailCount >= FAIL_THRESHOLD) {
        log.error(
          { errno, count: recentFailCount },
          "cache-gc: too many unlink failures — aborting sweep",
        );
        throw new Error(
          `cache-gc aborted: ${recentFailCount} consecutive ${errno} failures`,
          {
            cause: err,
          },
        );
      }
      return false;
    }
  }

  try {
    await walk(libraryRoot, "");
  } catch (err) {
    // unlinkSafe threw past FAIL_THRESHOLD — return the partial result so
    // the caller can log the operator-actionable error without losing the
    // counts collected up to the abort point.
    log.error(
      {
        err: err instanceof Error ? err.message : err,
        scanned,
        deleted,
        skippedRecent,
      },
      "cache-gc sweep aborted with partial result",
    );
  }
  return { scanned, deleted, skipped_recent: skippedRecent };
}
