/**
 * Assets repository — trash, purge and restore.
 *
 * The SQLite counterparts of `db/assets.trash.ts`. These are the multi-step
 * workflows the trash route used to inline; the filesystem, Meilisearch and
 * change-feed orchestration stays in the route, because this layer takes no
 * dependency on any of them.
 *
 * ## Trash is per-location, and that is what the rows make obvious
 *
 * Moving a file to trash moves one location, not the whole asset. An asset
 * deduped across two libraries keeps its other entries exactly where they
 * were, which on Mongo needed an `arrayFilters` update against
 * `fileinfo.$[entry]` and is one `UPDATE … WHERE asset_id = ? AND library_id =
 * ? AND path = ? AND filename = ?` here. Same-entry matching is the shape of
 * the statement rather than a rule to remember.
 *
 * ## The re-arms are the correctness mechanism, not a nicety
 *
 * Both workflows reset `meili` in the same transaction that stamps or clears
 * `deleted_at`. The rewritten trash entry is still *live* by the per-entry
 * definition — only the asset's own `deleted_at` is stamped — so the meili
 * stage's claim query would never re-pick the row on its own, and the route's
 * inline Meilisearch call is a best-effort fast path that a transient outage
 * defeats. Resetting the stage makes the row claimable, so the stage rebuilds
 * the full search document on its next tick.
 *
 * They also reset `thumb` and `preview`. Trash is a relocate — the bytes move
 * under `.maple/trash/` — and those two caches are keyed on the file's path,
 * so without the reset the row keeps claiming "done" for a thumbnail at a path
 * the file no longer occupies. The expensive per-image stages are deliberately
 * untouched: the pixels did not change.
 */

import * as path from 'node:path';
import type { ObjectId } from 'mongodb';
import type { SqlStatement } from '../protocol.ts';
import { meiliRearmStatement, relocateCacheRearmStatements } from './assets.stage-rearm.ts';
import {
  assetsDb,
  changesAt,
  deleteOutcome,
  updateOutcome,
  type DeleteOutcome,
  type SqliteDb,
  type UpdateOutcome,
} from './db-handle.ts';

/** Identity of the one location a trash or restore workflow is moving. */
export interface LocationSource {
  libraryId: ObjectId;
  path: string;
  filename: string;
}

/**
 * An absolute path as a `(path, filename)` pair relative to a library root, or
 * `null` when it does not fall under that root. The directory component is
 * POSIX-normalised so the stored value obeys the same contract on every host.
 */
function relSplit(libraryRoot: string, absPath: string): { path: string; filename: string } | null {
  const relDir = path.relative(libraryRoot, path.dirname(absPath));
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) return null;
  const normalised = relDir === '' || relDir === '.' ? '' : relDir.split(path.sep).join('/');
  return { path: normalised, filename: path.basename(absPath) };
}

/**
 * Rewrites one location in place, identified by the entry the caller moved.
 *
 * Clearing `missing_since`, `missing_reason` and `keep` alongside the address
 * is not incidental: the Mongo update replaces the whole array element with a
 * four-field object, so those three fields disappear with it. An `UPDATE` that
 * set only the address would leave a stale `missing_since` on an entry that
 * now points at a file which is definitely there.
 */
const REWRITE_ENTRY_SQL = `
  UPDATE asset_locations
     SET library_id = ?, path = ?, filename = ?,
         deleted_at = NULL, missing_since = NULL, missing_reason = NULL, keep = 0
   WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?`;

const REPLACE_ENTRIES_DELETE_SQL = `DELETE FROM asset_locations WHERE asset_id = ?`;

/**
 * Inserts the single replacement entry, sourced from `assets` so an id that
 * does not exist inserts nothing instead of failing the foreign key and
 * rolling the whole transaction back. Mongo's `updateOne` on a missing `_id`
 * is a no-op with `matchedCount: 0`, and this preserves that.
 */
const REPLACE_ENTRIES_INSERT_SQL = `
  INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename)
  SELECT id, 0, ?, ?, ? FROM assets WHERE id = ?`;

/**
 * The statements that put the asset's locations into their post-move state.
 *
 * With a `source` the workflow rewrites exactly that entry and leaves every
 * other one alone. Without one it falls back to the historical single-entry
 * contract — replace the whole set with one entry — which is what call sites
 * that cannot name the moved entry have always got.
 */
function locationStatements(
  assetId: string,
  destination: { libraryId: string; path: string; filename: string },
  source: LocationSource | undefined,
): SqlStatement[] {
  if (source) {
    return [
      {
        sql: REWRITE_ENTRY_SQL,
        params: [
          destination.libraryId,
          destination.path,
          destination.filename,
          assetId,
          source.libraryId.toHexString(),
          source.path,
          source.filename,
        ],
      },
    ];
  }
  return [
    { sql: REPLACE_ENTRIES_DELETE_SQL, params: [assetId] },
    {
      sql: REPLACE_ENTRIES_INSERT_SQL,
      params: [destination.libraryId, destination.path, destination.filename, assetId],
    },
  ];
}

/**
 * Mark a live asset as soft-deleted and repoint the moved location at its
 * trash destination. `originalAbsPath` is preserved in `original_path` so the
 * restore workflow can put the file back.
 */
export async function markSoftDeleted(args: {
  id: ObjectId;
  /** The library root that owns this asset, so the destination can be made
   * relative to it. */
  libraryRoot: string;
  libraryId: ObjectId;
  newAbsPath: string;
  originalAbsPath: string;
  /** Identity of the entry that was moved to trash. Required for an asset with
   * several locations — without it the other entries would be replaced. */
  source?: LocationSource;
  dbOverride?: SqliteDb;
}): Promise<UpdateOutcome> {
  const db = assetsDb(args.dbOverride);
  const split = relSplit(args.libraryRoot, args.newAbsPath);
  if (!split) {
    throw new Error(
      `markSoftDeleted: newAbsPath ${args.newAbsPath} is outside libraryRoot ${args.libraryRoot}`,
    );
  }
  const hex = args.id.toHexString();
  const destination = {
    libraryId: args.libraryId.toHexString(),
    path: split.path,
    filename: split.filename,
  };
  const results = await db.transaction([
    {
      sql: `UPDATE assets SET deleted_at = ?, original_path = ? WHERE id = ?`,
      params: [new Date().toISOString(), args.originalAbsPath, hex],
    },
    ...locationStatements(hex, destination, args.source),
    meiliRearmStatement(hex),
    ...relocateCacheRearmStatements(hex),
  ]);
  return updateOutcome(changesAt(results, 0));
}

/**
 * Permanent purge: drop the asset. Called after the filesystem layer has
 * removed the file and its sidecars.
 *
 * One statement does what the Mongo version did plus what nothing did: the
 * asset's locations, faces, detail payload, search row, phasset links and
 * stage bookkeeping all carry `ON DELETE CASCADE`, so they go with it instead
 * of being orphaned rows nothing would ever look at again.
 */
export async function hardDelete(id: ObjectId, dbOverride?: SqliteDb): Promise<DeleteOutcome> {
  const db = assetsDb(dbOverride);
  const result = await db.write(`DELETE FROM assets WHERE id = ?`, [id.toHexString()]);
  return deleteOutcome(result.changes);
}

/**
 * Restore: drop a watcher-inserted transient row at the destination, then
 * repoint the canonical asset at its new location.
 *
 * The watcher race is real and the ordering matters. Between the filesystem
 * move and this write, the discover watcher may have seen the file at its
 * restore location and inserted an asset for it. On Mongo the stale row is
 * deleted first out of tidiness; here it has to be, because
 * `asset_locations_lib_path_name` is UNIQUE and the repoint would otherwise
 * collide with it. Both steps share one transaction, so a failure cannot leave
 * the library with the transient row deleted and nothing put back.
 */
export async function restoreFromTrash(args: {
  id: ObjectId;
  libraryRoot: string;
  libraryId: ObjectId;
  newAbsPath: string;
  size: number;
  /** Epoch milliseconds, typically `stat.mtimeMs`. The list endpoint divides
   * by 1000 on the way out; storing an ISO string here would NaN that. */
  mtimeMs: number;
  /** Identity of the trashed entry being restored. Same semantics as
   * {@link markSoftDeleted}'s `source`. */
  source?: LocationSource;
  dbOverride?: SqliteDb;
}): Promise<UpdateOutcome> {
  const db = assetsDb(args.dbOverride);
  const split = relSplit(args.libraryRoot, args.newAbsPath);
  if (!split) {
    throw new Error(
      `restoreFromTrash: newAbsPath ${args.newAbsPath} is outside libraryRoot ${args.libraryRoot}`,
    );
  }
  const hex = args.id.toHexString();
  const destination = {
    libraryId: args.libraryId.toHexString(),
    path: split.path,
    filename: split.filename,
  };
  const results = await db.transaction([
    {
      sql: `DELETE FROM assets
             WHERE id <> ?
               AND id IN (SELECT asset_id FROM asset_locations
                           WHERE library_id = ? AND path = ? AND filename = ?)`,
      params: [hex, destination.libraryId, destination.path, destination.filename],
    },
    {
      sql: `UPDATE assets
               SET size = ?, mtime = ?, deleted_at = NULL, original_path = NULL
             WHERE id = ?`,
      params: [args.size, args.mtimeMs, hex],
    },
    ...locationStatements(hex, destination, args.source),
    meiliRearmStatement(hex),
    ...relocateCacheRearmStatements(hex),
  ]);
  return updateOutcome(changesAt(results, 1));
}
