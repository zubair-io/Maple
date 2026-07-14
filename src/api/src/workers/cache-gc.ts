/**
 * Cache GC — sweep orphaned `.maple/{thumbs,previews}/*.{jpg,avif}` files.
 *
 * Walks a library root looking for `.maple/thumbs` and `.maple/previews`
 * directories. For each `.jpg`/`.avif` file it finds, derives the would-be
 * `maple_id` from the basename and unlinks the file when no asset row
 * claims it. `previews` is JPEG-only (`.jpg`); `thumbs` is AVIF-only
 * (`.avif`) since the thumb stage's v3 format migration — recognizing both
 * extensions everywhere is simpler than threading "which kind" through, and
 * previews will just never have a `.avif` file to match. `.jpg` files under
 * `thumbs` are legacy orphans left by the pre-v3 JPEG thumbnail pipeline.
 *
 * Two classes of orphan get cleaned up:
 *   1. Legacy `sha256_prefix16(basename)`-keyed thumbs (16 hex chars) written
 *      before the content-addressing migration. After PR 3 of the migration
 *      every fresh thumb is written under `<maple_id>.<ext>` (32 hex), so the
 *      16-char form is always an orphan post-migration.
 *   2. Stale `<maple_id>[_<size>].<ext>` files for assets that have been
 *      hard-deleted, or files at the previous location of a renamed asset
 *      whose `fileinfo[0]` has since moved.
 *
 * No migration sentinel:
 *   The set of orphans changes continuously (a re-render at a new size, a
 *   rename, a hard-delete each create one). A one-shot sentinel-gated sweep
 *   would miss every orphan produced after the sentinel was recorded.
 *   Instead, the supervisor calls `sweepOrphanedCaches` once at boot per
 *   registered library as a fire-and-forget background task. Bounded work:
 *   each sweep is O(files-in-library).
 */
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assetsCollection } from '../db/client.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('cache-gc');

export interface SweepResult {
  scanned: number;
  deleted: number;
  skipped_recent: number;
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
 * Matches `<maple_id>` (32 lowercase hex) or `<maple_id>_<size>` where size
 * is `[a-z0-9_]+` (e.g. `1280`, `full`, `dev_5`). The legacy `sha256_prefix16`
 * cache key is 16 hex chars and does NOT match — it falls through to the
 * "unknown shape, unlink" branch.
 *
 * The suffix class includes `_` (not just `[a-z0-9]+`) so the
 * display-preview stage's `<maple_id>_dev_<sidecar_ver>` developed-preview
 * filenames are recognized as known-shape and checked against `known`
 * instead of falling into the unconditional-delete branch. Without this,
 * every developed preview gets deleted as an "orphan" ~60s after every
 * server restart (`RECENT_THRESHOLD_MS` only protects freshly-written
 * files) — a real, live bug, not something the AVIF migration introduced.
 */
const MAPLE_ID_RE = /^[0-9a-f]{32}(?:_[a-z0-9_]+)?$/;

export async function sweepOrphanedCaches(libraryRoot: string): Promise<SweepResult> {
  // Build the set of known maple_ids once (one query per library). Projection
  // keeps the working set tight even on 100k-asset libraries; iterating the
  // cursor avoids materialising the full result array as an intermediate.
  const coll = await assetsCollection();
  const known = new Set<string>();
  const cursor = coll.find({ maple_id: { $type: 'string' } }, { projection: { maple_id: 1 } });
  for await (const doc of cursor) {
    if (typeof doc.maple_id === 'string') known.add(doc.maple_id);
  }

  let scanned = 0;
  let deleted = 0;
  let skippedRecent = 0;
  const now = Date.now();

  let recentFailErrno: string | null = null;
  let recentFailCount = 0;

  async function walk(dir: string): Promise<void> {
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
        if (entry.name === '.maple') {
          await sweepCacheDir(path.join(full, 'thumbs'));
          await sweepCacheDir(path.join(full, 'previews'));
        } else if (!entry.name.startsWith('.')) {
          await walk(full);
        }
      }
    }
  }

  async function sweepCacheDir(cacheDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = (await fs.readdir(cacheDir, { withFileTypes: true })) as Dirent[];
    } catch {
      return; // ENOENT — fine, no cache here.
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (ext !== '.jpg' && ext !== '.avif') continue;
      scanned += 1;
      const stem = entry.name.slice(0, -ext.length);
      const fullPath = path.join(cacheDir, entry.name);

      // TOCTOU defense: `known` was snapshotted before this walk began. A
      // stage may have written this file in the meantime. If the file's
      // mtime is within the recency window, defer to the next boot's sweep.
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
      // Stem is `<maple_id>` or `<maple_id>_<size>`. First 32 chars are the id.
      const mapleId = stem.slice(0, 32);
      if (!known.has(mapleId)) {
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
      const errno = (err as { code?: string } | null)?.code ?? 'UNKNOWN';
      if (errno === 'ENOENT') {
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
      log.warn({ p, errno, err: err instanceof Error ? err.message : err }, 'unlink failed');
      if (recentFailCount >= FAIL_THRESHOLD) {
        log.error(
          { errno, count: recentFailCount },
          'cache-gc: too many unlink failures — aborting sweep',
        );
        throw new Error(`cache-gc aborted: ${recentFailCount} consecutive ${errno} failures`, {
          cause: err,
        });
      }
      return false;
    }
  }

  try {
    await walk(libraryRoot);
  } catch (err) {
    // unlinkSafe threw past FAIL_THRESHOLD — return the partial result so
    // the caller can log the operator-actionable error without losing the
    // counts collected up to the abort point.
    log.error(
      { err: err instanceof Error ? err.message : err, scanned, deleted, skippedRecent },
      'cache-gc sweep aborted with partial result',
    );
  }
  return { scanned, deleted, skipped_recent: skippedRecent };
}
