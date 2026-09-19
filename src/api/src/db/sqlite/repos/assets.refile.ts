/**
 * The backup-refiling migrations' own reads and writes — the SQLite port of
 * what `workers/migration/refile-backups.ts`,
 * `workers/migration/refile-legacy-daydir.ts` and the `moveBackupAsset` helper
 * they share used to spell as positional-`$` updates over `fileinfo[]` (#3787).
 *
 * These migrations relocate a mobile-backup photo into the folder a fresh
 * ingest would use today. The filesystem half is crash-safe and lives in
 * `workers/migration/restructure-fs.ts`; this module is only the database write
 * that sits between "the copy is verified" and "the sources are deleted".
 *
 * ## The repoint's guard is the whole safety argument
 *
 * {@link repointBackupLocation} matches the old `(library_id, path, filename)`
 * and its liveness in the statement's own `WHERE`, so a `false` return means
 * the exact location the caller read is no longer there — a concurrent repoint,
 * a trash, a dedupe move. The caller then reverts its copies and never reaches
 * the delete. With the location matched by asset id alone, a concurrent change
 * would make the repoint silently miss while the accompanying timestamp write
 * still reported success, and the migration would delete a live file's source.
 *
 * `deleted_at IS NULL` is the liveness test, and `missing_since` is deliberately
 * not part of it: a refile may be resurrecting a location the reaper had tagged,
 * which is why the repoint clears the tag rather than refusing the row.
 *
 * ## `dedupeLiveFileinfo` has no counterpart here, by construction
 *
 * The Mongo helper ended by collapsing duplicate live `fileinfo` entries that a
 * concurrent discover sweep may have appended for the new path mid-move. The
 * UNIQUE index over `(library_id, path, filename)` means that second entry
 * cannot exist, so there is nothing to collapse — the race is prevented rather
 * than repaired.
 */

import type { ObjectId } from '../../object-id.ts';
import type { LocationKey } from './assets.discover.ts';
import {
  BACKUP_ORIGIN,
  CANDIDATE_COLUMNS,
  HAS_LIVE_LOCATION,
  LIVE_LOCATION,
  loadCandidateLocations,
  toCandidate,
  type CandidateRow,
  type CandidateScope,
  type MigrationCandidate,
  type MigrationMarker,
} from './assets.migrations.ts';
import { meiliRearmStatement, relocateCacheRearmStatements } from './assets.stage-rearm.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toHex } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/**
 * Backup-origin assets holding at least one live location.
 *
 * Liveness is "has ≥ 1 live entry", not "entry zero is live". The old form
 * leaked delete-then-readd assets — a tombstone at index 0 with the live entry
 * later — through MongoDB's array null-path matching; the migration then took
 * the tombstone as primary, the move skipped it without stamping, and those
 * un-stampable rows head-of-line-blocked every unsorted batch (#1519).
 */
export const REFILE_BACKUP_SCOPE: CandidateScope = {
  sql: `${BACKUP_ORIGIN} AND ${HAS_LIVE_LOCATION}`,
};

/**
 * Assets with a live location still in either shape of the old three-segment
 * backup day-dir layout: `<year>/<location>/<MM>-<DD>`, or `<year>/<MM>/<DD>`
 * with no location.
 *
 * This is the conversion of what was a Mongo filter object holding two anchored
 * regular expressions, and the shape is worth spelling out because SQLite has
 * no regex. `GLOB` supplies the anchoring and the per-character digit classes,
 * which covers the no-location shape exactly. It does not supply "one segment
 * with no slash in it", so the with-location shape is `GLOB` plus a count of
 * the separators — `length(path) - length(replace(path, '/', '')) = 2` — and
 * together those two are again exact rather than a superset.
 *
 * Exactness matters less than it looks, because the migration re-tests every
 * candidate against the same pure `isLegacyDaydirPath` gate it always did and
 * stamps a non-match done. But a loose predicate here would drag unrelated
 * current-layout assets into the sweep and stamp a marker on each, which is
 * noise an operator would have to explain.
 *
 * Neither form can use an index: `asset_locations_lib_path_name` leads with
 * `library_id`, and a `GLOB` with no literal prefix cannot seek. The Mongo
 * predicate it replaces was a regex against a multikey index and scanned too.
 */
export const LEGACY_DAYDIR_SCOPE: CandidateScope = {
  sql: `EXISTS (
    SELECT 1 FROM asset_locations l
     WHERE l.asset_id = a.id AND ${LIVE_LOCATION}
       AND ((l.path GLOB '[0-9][0-9][0-9][0-9]/*/[0-9][0-9]-[0-9][0-9]'
             AND length(l.path) - length(replace(l.path, '/', '')) = 2)
         OR l.path GLOB '[0-9][0-9][0-9][0-9]/[0-9][0-9]/[0-9][0-9]'))`,
};

/**
 * Stamp a done-marker only if the asset's canonical location is still where the
 * caller read it — the "already in the right folder, nothing to move" path.
 *
 * Gated rather than unconditional because the stamp is one-way for this
 * generation: if a concurrent operation moved the location between the read and
 * now, the asset may no longer *be* in the right folder, and stamping it would
 * freeze it in the wrong one until someone bumped the constant. On a mismatch
 * the caller leaves it unstamped and a later tick re-evaluates from the current
 * state.
 */
export async function stampMarkerIfUnmoved(
  assetId: ObjectId,
  entry: LocationKey,
  marker: MigrationMarker,
  version: number,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const result = await sqliteDb(dbOverride).write(
    `UPDATE assets SET ${marker} = ?
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM asset_locations l
         WHERE l.asset_id = assets.id AND l.library_id = ? AND l.path = ? AND l.filename = ?
           AND l.deleted_at IS NULL)`,
    [version, toHex(assetId), toHex(entry.library_id), entry.path, entry.filename],
  );
  return result.changes > 0;
}

/**
 * Repoint a backup asset's canonical location onto its new directory, and
 * record everything that has to change with it.
 *
 * The decisive write is issued first and alone; the follow-ups only run once it
 * has won. They cannot share its transaction, because the guard is consumed by
 * the update itself — after it lands the old key no longer exists, so there is
 * nothing left for the other statements to be conditional on. A crash in the
 * gap leaves a correctly repointed row that the next tick re-evaluates as
 * "already in place" and stamps then.
 *
 * `thumb` and `preview` reset to version 0 because their cache key is derived
 * from the file's path, so the `.maple` derivatives were dropped with the move
 * (`docs/caching.md`). The expensive per-image stages are deliberately not in
 * that list: the pixels did not change. `meili` is re-armed because `filename`
 * is the highest-weight lexical field in the search index and a relocate that
 * skipped it leaves the document permanently stale (#2357).
 */
export async function repointBackupLocation(
  assetId: ObjectId,
  from: LocationKey,
  to: { path: string; filename: string },
  appleRenderedPath: string | null,
  marker: { name: MigrationMarker; version: number } | undefined,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const db = sqliteDb(dbOverride);
  const id = toHex(assetId);
  const moved = await db.write(
    `UPDATE asset_locations
        SET path = ?, filename = ?, missing_since = NULL, missing_reason = NULL
      WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?
        AND deleted_at IS NULL`,
    [to.path, to.filename, id, toHex(from.library_id), from.path, from.filename],
  );
  if (moved.changes === 0) return false;

  const stamp = marker === undefined ? '' : `, ${marker.name} = ?`;
  await db.transaction([
    {
      sql: `UPDATE assets SET apple_rendered_path = ?${stamp} WHERE id = ?`,
      params:
        marker === undefined ? [appleRenderedPath, id] : [appleRenderedPath, marker.version, id],
    },
    meiliRearmStatement(id),
    ...relocateCacheRearmStatements(id),
  ]);
  return true;
}

/**
 * One asset in the shape the refile logic reads, plus whether it came from a
 * mobile backup.
 *
 * The describe stage's on-the-fly screenshot relocation needs exactly this for
 * a single asset: the `<year>/Screenshot` layout is the PhotoKit-backup
 * contract, and a folder-scanned library is laid out by the user and left
 * alone.
 */
export interface BackupAsset extends MigrationCandidate {
  backupOrigin: boolean;
}

export async function findBackupAssetById(
  id: ObjectId,
  dbOverride?: SqliteDb,
): Promise<BackupAsset | null> {
  const db = sqliteDb(dbOverride);
  const hex = toHex(id);
  const rows = await db.read<CandidateRow & { backup_origin: number }>(
    `SELECT ${CANDIDATE_COLUMNS},
            EXISTS (SELECT 1 FROM asset_phasset_links p WHERE p.asset_id = a.id) AS backup_origin
       FROM assets a WHERE a.id = ?`,
    [hex],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const locations = await loadCandidateLocations(db, [hex]);
  return {
    ...toCandidate(row, locations.get(hex) ?? []),
    backupOrigin: row.backup_origin === 1,
  };
}
