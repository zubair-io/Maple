/**
 * Cache GC — sweep orphaned `.maple/{thumbs,previews}/*.jpg` files.
 *
 * Walks a library root looking for `.maple/thumbs` and `.maple/previews`
 * directories. For each `.jpg` it finds, derives the would-be `maple_id`
 * from the basename and unlinks the file when no asset row claims it.
 *
 * Two classes of orphan get cleaned up:
 *   1. Legacy `sha256_prefix16(basename)`-keyed thumbs (16 hex chars) written
 *      before the content-addressing migration. After PR 3 of the migration
 *      every fresh thumb is written under `<maple_id>.jpg` (32 hex), so the
 *      16-char form is always an orphan post-migration.
 *   2. Stale `<maple_id>[_<size>].jpg` files for assets that have been
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
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assetsCollection } from '../db/client.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('cache-gc');

export interface SweepResult {
  scanned: number;
  deleted: number;
}

/**
 * Matches `<maple_id>` (32 lowercase hex) or `<maple_id>_<size>` where size
 * is `[a-z0-9]+` (e.g. `1280`, `full`). The legacy `sha256_prefix16` cache
 * key is 16 hex chars and does NOT match — it falls through to the "unknown
 * shape, unlink" branch.
 */
const MAPLE_ID_RE = /^[0-9a-f]{32}(?:_[a-z0-9]+)?$/;

export async function sweepOrphanedCaches(libraryRoot: string): Promise<SweepResult> {
  // Build the set of known maple_ids once (one query per library). Projection
  // keeps the working set tight even on 100k-asset libraries.
  const coll = await assetsCollection();
  const known = new Set<string>();
  for (const doc of await coll
    .find({ maple_id: { $type: 'string' } }, { projection: { maple_id: 1 } })
    .toArray()) {
    if (typeof doc.maple_id === 'string') known.add(doc.maple_id);
  }

  let scanned = 0;
  let deleted = 0;

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })) as never;
    } catch {
      return;
    }
    for (const entry of entries) {
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
    let entries: import('node:fs').Dirent[];
    try {
      entries = (await fs.readdir(cacheDir, { withFileTypes: true })) as never;
    } catch {
      return; // ENOENT — fine, no cache here.
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jpg')) continue;
      scanned += 1;
      const stem = entry.name.slice(0, -4); // strip .jpg
      if (!MAPLE_ID_RE.test(stem)) {
        // basename isn't shaped like a maple_id (e.g. legacy 16-hex
        // sha256_prefix16 key). Definitely orphaned.
        await unlinkSafe(path.join(cacheDir, entry.name));
        deleted += 1;
        continue;
      }
      // Stem is `<maple_id>` or `<maple_id>_<size>`. First 32 chars are the id.
      const mapleId = stem.slice(0, 32);
      if (!known.has(mapleId)) {
        await unlinkSafe(path.join(cacheDir, entry.name));
        deleted += 1;
      }
    }
  }

  async function unlinkSafe(p: string): Promise<void> {
    try {
      await fs.unlink(p);
    } catch (err) {
      log.warn({ p, err: err instanceof Error ? err.message : err }, 'unlink failed');
    }
  }

  await walk(libraryRoot);
  return { scanned, deleted };
}
