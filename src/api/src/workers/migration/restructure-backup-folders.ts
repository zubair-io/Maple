/**
 * Migration: "Restructure backup folders" (#744).
 *
 * Moves already-backed-up photos out of the now-retired `…/MM-DD/` day-folder
 * into the flatter `year/place/` (or `year/MM/`) layout. Scoped to backup-origin
 * assets — those carrying `phasset_links` — whose CANONICAL location
 * (`fileinfo[0]`) still sits in an old-layout 3-segment dir.
 *
 * The per-asset move (copy → verify → repoint → delete → drop cache → reclaim
 * folder) lives in the shared `moveBackupAsset`; this migration only supplies
 * the target dir (drop the 3rd path segment) and the candidate query.
 */

import type { FileInfo } from '../../db/schema.ts';
import { assetsCollection } from '../../db/client.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { child as childLogger } from '../../log.ts';
import type { Migration, MigrationBatchResult } from './types.ts';
import { OLD_LAYOUT_DIR_RE, restructureDir } from './restructure-path.ts';
import { SourceMissingError } from './restructure-fs.ts';
import { moveBackupAsset } from './move-backup-asset.ts';

const log = childLogger('migration:restructure');

/** Selects backup-origin assets whose canonical entry is an old-layout dir. */
function candidateFilter() {
  return {
    'phasset_links.0': { $exists: true },
    'fileinfo.0.deleted_at': null,
    'fileinfo.0.path': { $regex: OLD_LAYOUT_DIR_RE },
  } as const;
}

export const restructureBackupFolders: Migration = {
  id: 'restructure-backup-folders',
  title: 'Restructure backup folders',
  description:
    'Move already-backed-up photos out of the old MM-DD day-folder into the ' +
    'flatter year/place (or year/month) layout. Copy-verify-delete, never ' +
    'overwrites; duplicates are deduped, name clashes get a numeric suffix.',

  async countRemaining(): Promise<number> {
    const coll = await assetsCollection();
    return coll.countDocuments(candidateFilter());
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const coll = await assetsCollection();
    let libs: ReadonlyMap<string, string>;
    try {
      libs = await loadLibraryRoots();
    } catch {
      libs = new Map();
    }

    const docs = await coll
      .find(candidateFilter(), {
        projection: { _id: 1, fileinfo: 1, maple_id: 1, apple_rendered_path: 1 },
      })
      .limit(batchSize)
      .toArray();

    let processed = 0;
    let errors = 0;
    for (const doc of docs) {
      const primary = (doc.fileinfo as FileInfo[] | undefined)?.[0];
      const root = primary ? libs.get(primary.library_id.toHexString()) : undefined;
      if (!root) {
        // Library unregistered / offline — skip without erroring; retried once a
        // tick until the mount returns. Never delete on an offline mount.
        continue;
      }
      // Drop the 3rd (day) segment. `restructureDir` returns null for a path
      // that isn't actually old-layout (regex over-match guard) → skip.
      const newDir = restructureDir(primary!.path);
      if (!newDir) continue;
      try {
        const result = await moveBackupAsset(coll, doc, root, newDir);
        if (result === 'moved') processed++;
      } catch (err) {
        if (err instanceof SourceMissingError) {
          // Source gone from disk — nothing to move. Left for the reaper.
          log.warn(
            { _id: String(doc._id), err: err.message },
            'restructure: source missing — skipped',
          );
          continue;
        }
        errors++;
        log.error(
          { _id: String(doc._id), err: err instanceof Error ? err.message : err },
          'restructure: asset move failed — left in place for retry',
        );
      }
    }
    return { processed, errors };
  },
};
