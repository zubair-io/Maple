/**
 * Migration: "Move screenshots into a Screenshot folder".
 *
 * Re-files already-backed-up screenshots out of their date/location folder and
 * into the single `<year>/Screenshot` folder that the backup ingest now routes
 * fresh screenshots to (`backup/path-formatter.ts`).
 *
 * Scope: backup-origin assets (`phasset_links`) whose canonical entry
 * (`fileinfo[0]`) is live, that are flagged `is_screenshot: true` (the EXIF
 * filename seed, refined by the qwen2.5-vl describe stage — so this catches
 * screenshots the ingest-time filename heuristic missed, e.g. iOS captures that
 * arrive as `IMG_*.PNG`), and that are not already sitting in a
 * `<year>/Screenshot` folder.
 *
 * Idempotency is structural, not a stamped version: once an asset is moved its
 * canonical path is `<year>/Screenshot`, which the candidate filter excludes —
 * so a re-run is a no-op without a per-asset marker. The crash-safe move itself
 * (copy → verify → repoint → delete → reclaim) is the shared `moveBackupAsset`.
 *
 * Interaction with the geo migration: `restructure-backup-geo` excludes
 * `is_screenshot` assets, so the two never fight over a GPS-bearing screenshot —
 * screenshots are owned exclusively by this migration.
 */

import type { Filter } from 'mongodb';
import type { AssetDoc, FileInfo } from '../../db/schema.ts';
import { assetsCollection } from '../../db/client.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { child as childLogger } from '../../log.ts';
import type { Migration, MigrationBatchResult } from './types.ts';
import { SourceMissingError } from './restructure-fs.ts';
import { moveBackupAsset } from './move-backup-asset.ts';
import {
  computeScreenshotDir,
  DATED_BACKUP_DIR_RE,
  SCREENSHOT_DIR_RE,
} from './restructure-screenshot-path.ts';

const log = childLogger('migration:screenshots');

/** Selects backup-origin screenshots whose canonical entry is a dated backup
 * folder (`DATED_BACKUP_DIR_RE`) that is NOT already `<year>/Screenshot` (the
 * `$nor` exclusion is the idempotency gate, so `countRemaining()` reaches 0
 * once everything is filed). */
function candidateFilter(): Filter<AssetDoc> {
  return {
    'phasset_links.0': { $exists: true },
    'fileinfo.0.deleted_at': null,
    is_screenshot: true,
    'fileinfo.0.path': { $regex: DATED_BACKUP_DIR_RE },
    $nor: [{ 'fileinfo.0.path': { $regex: SCREENSHOT_DIR_RE } }],
  };
}

export const restructureBackupScreenshots: Migration = {
  id: 'restructure-backup-screenshots',
  title: 'Move screenshots into a Screenshot folder',
  description:
    'Re-file backed-up screenshots into a single year/Screenshot folder, out ' +
    'of their date or location folder. Screenshots are detected from the ' +
    'is_screenshot flag (filename + the vision describe stage). ' +
    'Copy-verify-delete, never overwrites; idempotent.',

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
        projection: {
          _id: 1,
          fileinfo: 1,
          maple_id: 1,
          apple_rendered_path: 1,
          'exif.captured_year': 1,
        },
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

      const newDir = computeScreenshotDir(doc);
      if (newDir == null) {
        // No determinable year. The candidate filter requires a `<year>/…`
        // path, so this is unreachable in practice; guard defensively and skip
        // (leave the file in place) rather than risk a bad move.
        log.warn(
          { _id: String(doc._id), path: primary?.path },
          'screenshots: could not determine year — left in place',
        );
        continue;
      }

      try {
        const result = await moveBackupAsset(coll, doc, root, newDir);
        // 'moved' (relocated) reduces the remaining count. 'noop'/'skipped'
        // can't occur here: the filter excludes already-filed assets, so the
        // target always differs from the source.
        if (result === 'moved') processed++;
      } catch (err) {
        if (err instanceof SourceMissingError) {
          log.warn(
            { _id: String(doc._id), err: err.message },
            'screenshots: source missing — skipped',
          );
          continue;
        }
        errors++;
        log.error(
          { _id: String(doc._id), err: err instanceof Error ? err.message : err },
          'screenshots: asset move failed — left in place for retry',
        );
      }
    }
    return { processed, errors };
  },
};
