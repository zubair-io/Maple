/**
 * What the reconciliation sweep reads per directory, and the repoint the
 * external-rename pass writes (#3787).
 *
 * Both halves belong together because they are two ends of one decision: the
 * directory read produces the candidate pairs, and the repoint is what happens
 * when a pair resolves. Separated from the per-event verbs in
 * `./assets.discover.ts` because the sweep runs once per directory where those
 * run once per file.
 */

import type { ObjectId } from 'mongodb';
import type { AssetExif, FileInfo } from '../../schema.ts';
import type { LocationKey } from './assets.discover.ts';
import { meiliRearmStatement, relocateCacheRearmStatements } from './assets.stage-rearm.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toBool, toHex, toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/** The three bound values every location-keyed statement takes, in order. */
function locationParams(key: LocationKey): [string, string, string] {
  return [toHex(key.library_id), key.path, key.filename];
}

/** One recorded location in a swept directory, with what a rename fingerprint needs. */
export interface RecordedInDirectory {
  assetId: ObjectId;
  fileinfo: FileInfo;
  size: number;
  exif: AssetExif | null;
}

/**
 * Every live-asset location recorded directly in one directory — the sweep's
 * single indexed read per visit, which drives both "what is new" and "what is
 * gone".
 *
 * `size` and `exif` ride along because the rename-reconcile pass fingerprints a
 * missing candidate from them and cannot re-read a file that is already gone.
 *
 * **One row per location, where Mongo returned one per asset.** The query this
 * replaces projected `fileinfo.$`, the *first* matching array entry, so an
 * asset holding two files in the same directory reported only one of them and
 * the second was permanently invisible to the sweep's diff — it would never be
 * detected as new and never confirmed as removed. A location is a row here, so
 * both come back.
 */
export async function listRecordedInDirectory(
  libraryId: ObjectId,
  path: string,
  dbOverride?: SqliteDb,
): Promise<RecordedInDirectory[]> {
  const rows = await sqliteDb(dbOverride).read<{
    asset_id: string;
    filename: string;
    deleted_at: string | null;
    missing_since: string | null;
    missing_reason: string | null;
    keep: number;
    size: number;
    exif: string | null;
  }>(
    `SELECT l.asset_id, l.filename, l.deleted_at, l.missing_since, l.missing_reason, l.keep,
            a.size, a.exif
       FROM asset_locations l
       JOIN assets a ON a.id = l.asset_id
      WHERE l.library_id = ? AND l.path = ? AND a.deleted_at IS NULL`,
    [toHex(libraryId), path],
  );
  return rows.map((row) => ({
    assetId: toObjectId(row.asset_id),
    fileinfo: {
      library_id: libraryId,
      path,
      filename: row.filename,
      deleted_at: row.deleted_at,
      missing_since: row.missing_since,
      missing_reason: row.missing_reason,
      keep: toBool(row.keep),
    },
    size: row.size,
    exif: row.exif === null ? null : (JSON.parse(row.exif) as AssetExif),
  }));
}

/**
 * Repoint a live location onto a new name, for the external-rename
 * reconciliation the sweep runs before it emits ordinary created/removed pairs.
 *
 * The old `(library, path, filename)` and its liveness are in the statement's
 * own `WHERE`, not just in the row lookup, and that is what makes the returned
 * boolean trustworthy. If a concurrent writer changed that exact location
 * between the caller's read and this write — another repoint, a trash, a dedupe
 * move — the update matches nothing and the caller declines instead of
 * attaching one photo's edit history to another.
 *
 * The decisive write is issued on its own and the follow-ups only once it has
 * won. They cannot share its transaction, because the guard is consumed by the
 * update itself: after it lands the old key no longer exists, so there is
 * nothing left for the other statements to be conditional on. A crash in the
 * gap leaves a correctly repointed row whose search document and path-keyed
 * caches re-arm on the next sweep instead of this one.
 */
export async function repointLocation(
  assetId: ObjectId,
  from: LocationKey,
  to: { path: string; filename: string },
  indexedAt: string,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const db = sqliteDb(dbOverride);
  const id = toHex(assetId);
  const moved = await db.write(
    `UPDATE asset_locations
        SET path = ?, filename = ?, missing_since = NULL, missing_reason = NULL
      WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?
        AND deleted_at IS NULL`,
    [to.path, to.filename, id, ...locationParams(from)],
  );
  if (moved.changes === 0) return false;
  await db.transaction([
    { sql: `UPDATE assets SET indexed_at = ? WHERE id = ?`, params: [indexedAt, id] },
    meiliRearmStatement(id),
    ...relocateCacheRearmStatements(id),
  ]);
  return true;
}

/**
 * Put a repointed location back where it was, restoring its missing tags.
 *
 * The exact reverse of {@link repointLocation}, used only when the repoint
 * succeeded but the follow-on sidecar move then failed — the one ordering in
 * which the row and the sidecar's actual location would otherwise disagree.
 * Best-effort: the caller logs a failure and leaves the row pointing at a
 * location with no sidecar of its own, which is an orphaned-sidecar failure
 * rather than a misattributed-edits one.
 */
export async function restoreLocation(
  assetId: ObjectId,
  current: LocationKey,
  original: Pick<FileInfo, 'path' | 'filename' | 'missing_since' | 'missing_reason'>,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const result = await sqliteDb(dbOverride).write(
    `UPDATE asset_locations
        SET path = ?, filename = ?, missing_since = ?, missing_reason = ?
      WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?
        AND deleted_at IS NULL`,
    [
      original.path,
      original.filename,
      original.missing_since ?? null,
      original.missing_reason ?? null,
      toHex(assetId),
      ...locationParams(current),
    ],
  );
  return result.changes > 0;
}
