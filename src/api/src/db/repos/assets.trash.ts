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
import {
  committedLifecycleStatements,
  lifecycleCommitGuard,
  type LifecycleCommit,
} from '../../cloud-backup/lifecycle-commit.ts';
import type { ObjectId } from '../object-id.ts';
import {
  trashPurgeGuard,
  type TrashPurgeCandidate,
} from '../../cloud-backup/trash-purge-admission.ts';
import type { SqlStatement } from '../sqlite/protocol.ts';
import { searchRearmStatements, relocateCacheRearmStatements } from './assets.stage-rearm.ts';
import {
  sqliteDb,
  changesAt,
  matchedOne,
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
  destination: Destination,
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

/** The destination of a move, resolved relative to the library that owns it. */
interface Destination {
  libraryId: string;
  path: string;
  filename: string;
}

/**
 * The destination as a `(library, directory, filename)` triple, or a thrown
 * error naming the caller when the path escapes the library root.
 *
 * Both workflows fail the same way on the same input, so they resolve it the
 * same way; the caller's name is threaded through only so the message says
 * which one refused.
 */
function resolveDestination(
  caller: string,
  args: {
    libraryRoot: string;
    libraryId: ObjectId;
    newAbsPath: string;
  },
): Destination {
  const split = relSplit(args.libraryRoot, args.newAbsPath);
  if (!split) {
    throw new Error(
      `${caller}: newAbsPath ${args.newAbsPath} is outside libraryRoot ${args.libraryRoot}`,
    );
  }
  return { libraryId: args.libraryId.toHexString(), path: split.path, filename: split.filename };
}

/**
 * The tail both workflows share: repoint the locations, then re-arm the search
 * stage and the two path-keyed caches.
 */
function moveTailStatements(
  assetId: string,
  destination: Destination,
  source: LocationSource | undefined,
): SqlStatement[] {
  return [
    ...locationStatements(assetId, destination, source),
    ...searchRearmStatements(assetId),
    ...relocateCacheRearmStatements(assetId),
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
  lifecycle?: LifecycleCommit;
  dbOverride?: SqliteDb;
}): Promise<UpdateOutcome> {
  const db = sqliteDb(args.dbOverride);
  const destination = resolveDestination('markSoftDeleted', args);
  const hex = args.id.toHexString();
  const guard = lifecycleCommitGuard(args.lifecycle);
  const results = await db.transaction([
    ...guard,
    {
      sql: `UPDATE assets SET deleted_at = ?, original_path = ? WHERE id = ?`,
      params: [new Date().toISOString(), args.originalAbsPath, hex],
    },
    ...moveTailStatements(hex, destination, args.source),
    ...committedLifecycleStatements(
      hex,
      destination.libraryId,
      path.relative(args.libraryRoot, args.originalAbsPath).split(path.sep).join('/'),
      path.posix.join(destination.path, destination.filename),
      'trash',
      args.lifecycle,
    ),
  ]);
  return updateOutcome(matchedOne(changesAt(results, guard.length)));
}

/**
 * Permanent purge: drop the asset. Called after the filesystem layer has
 * removed the file and its sidecars.
 *
 * One statement does what the Mongo version did plus what nothing did: the
 * asset's locations, faces, detail payload, search row, phasset links and
 * stage bookkeeping all carry `ON DELETE CASCADE`, so they go with it instead
 * of being orphaned rows nothing would ever look at again.
 *
 * That cascade is also why the reported count is not the statement's raw row
 * count. `bun:sqlite` reports every row the statement changed, cascaded
 * deletes and trigger writes included — a ten-row asset deletes as sixteen —
 * and `deletedCount` on the wire means "documents removed". The delete targets
 * one primary key, so the answer is one or nothing.
 */
export async function hardDelete(id: ObjectId, dbOverride?: SqliteDb): Promise<DeleteOutcome> {
  const db = sqliteDb(dbOverride);
  const result = await db.write(`DELETE FROM assets WHERE id = ?`, [id.toHexString()]);
  return deleteOutcome(matchedOne(result.changes));
}

/** Retention may forget an unbacked reaped row, but cannot turn absence into backup erasure. */
export async function deleteReapedWithoutActiveBackup(
  id: ObjectId,
  dbOverride?: SqliteDb,
  expected?: TrashPurgeCandidate,
): Promise<DeleteOutcome> {
  // Paused mirrors retain copies even though their writer creates no entries.
  // Removed destinations have no remaining configured cleanup authority. An
  // explicit purge intent authorizes DB-only cleanup while durable erasure retries.
  const guard = expected ? trashPurgeGuard(expected) : { sql: '', params: [] };
  const result = await sqliteDb(dbOverride).write(
    `DELETE FROM assets AS a WHERE id=? AND deleted_reason='reaped' ${guard.sql} AND
      (EXISTS(SELECT 1 FROM backup_lifecycle WHERE asset_id=a.id AND kind='purge') OR
        (NOT EXISTS(SELECT 1 FROM backup_entries e JOIN backup_destinations d ON d.id=e.destination_id
          WHERE e.asset_id=a.id AND e.state!='purged') AND NOT EXISTS
        (SELECT 1 FROM asset_locations l JOIN backup_destinations d ON d.library_id=l.library_id
          WHERE l.asset_id=a.id AND d.kind='folder'))) AND NOT EXISTS
      (SELECT 1 FROM backup_lifecycle WHERE asset_id=a.id AND (phase='prepared' OR lease_until>unixepoch('subsec')*1000))`,
    [id.toHexString(), ...guard.params],
  );
  return deleteOutcome(matchedOne(result.changes));
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
  lifecycle?: LifecycleCommit;
  dbOverride?: SqliteDb;
}): Promise<UpdateOutcome> {
  const db = sqliteDb(args.dbOverride);
  const destination = resolveDestination('restoreFromTrash', args);
  const hex = args.id.toHexString();
  const guard = lifecycleCommitGuard(args.lifecycle);
  const results = await db.transaction([
    ...guard,
    // A watcher duplicate with an unfinished backup cannot be discarded. Keep
    // this guard inside the write transaction so late backup admission is seen,
    // and reject before changing either asset, even if the source no longer matches.
    {
      sql: `CREATE TEMP TRIGGER maple_restore_backup_guard BEFORE DELETE ON main.assets
        WHEN EXISTS (SELECT 1 FROM backup_entries WHERE asset_id=OLD.id AND state!='purged')
        BEGIN SELECT RAISE(ABORT,'Watcher asset has unfinished backup obligations'); END`,
    },
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
    ...moveTailStatements(hex, destination, args.source),
    ...committedLifecycleStatements(
      hex,
      destination.libraryId,
      args.source ? path.posix.join(args.source.path, args.source.filename) : '',
      path.posix.join(destination.path, destination.filename),
      'active',
      args.lifecycle,
    ),
    { sql: `DROP TRIGGER maple_restore_backup_guard` },
  ]);
  return updateOutcome(matchedOne(changesAt(results, guard.length + 2)));
}

/** DB-only watcher claims with backup history occupy a restore candidate too. */
export async function restoreBackupDestinationOccupied(
  id: ObjectId,
  libraryId: ObjectId,
  relativePath: string,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const [row] = await sqliteDb(dbOverride).read<{ occupied: number }>(
    `SELECT EXISTS(SELECT 1 FROM asset_locations l WHERE l.asset_id<>?
      AND l.library_id=? AND l.path=? AND l.filename=? AND EXISTS
      (SELECT 1 FROM backup_entries e WHERE e.asset_id=l.asset_id AND e.state!='purged')) AS occupied`,
    [
      id.toHexString(),
      libraryId.toHexString(),
      path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
      path.posix.basename(relativePath),
    ],
  );
  return row?.occupied === 1;
}
