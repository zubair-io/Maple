/**
 * Assets addressed by `(library, directory, filename)` — the lookups the
 * path-addressed routes need, and the upload route's create-or-update (#3787).
 *
 * Every function here keys on `asset_locations_lib_path_name`, the UNIQUE index
 * that says two assets cannot claim the same file. That uniqueness is what makes
 * "the asset at this address" a well-defined phrase rather than a first-match
 * rule, and it is why none of these reads has to decide what to do with a second
 * hit.
 *
 * ## Three lookups, not one with switches
 *
 * They differ in exactly one thing — which of "the entry is live" and "the asset
 * is not in the trash" they require — and the three call sites each argue for
 * their own combination in their own comments:
 *
 *  - {@link findAssetAtAddress} (thumb/preview serving) wants a live entry on a
 *    live asset, because it is about to serve pixels from that path.
 *  - {@link findLiveAssetIdAtAddress} (the file-ops guard) wants a live entry
 *    and deliberately ignores the asset's own `deleted_at`: it is refusing to
 *    let a path-addressed move touch something the catalog still owns.
 *  - {@link findAssetToReplaceAtAddress} (upload) wants a live *asset* at that
 *    address whatever state the entry is in, because it is about to move those
 *    bytes aside and needs the row's hash and size to decide whether the copy is
 *    worth keeping.
 *
 * A single function with two booleans would read as one query at three call
 * sites and hide that those are three different questions.
 */

import type { ObjectId } from 'mongodb';
import type { FileInfo } from '../../schema.ts';
import { newObjectIdHex } from '../object-id.ts';
import { toFileInfo, type LocationRow } from './assets.rows.ts';
import { locationsByAssetIdsSql } from './assets.sql.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { seedStageRowStatements } from './stage-state.repo.ts';
import { toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

const ADDRESS_WHERE = `l.library_id = ? AND l.path = ? AND l.filename = ?`;
const LIVE_ENTRY = `l.deleted_at IS NULL AND l.missing_since IS NULL`;

/** What the thumb and preview routes read off the asset at an address. */
export interface AddressedAsset {
  _id: ObjectId;
  maple_id: string | null;
  fileinfo: FileInfo[];
}

/**
 * The live asset at an address, with its full location list.
 *
 * Backs `findAssetByAddress` in `routes/library/shared.ts`, whose callers use
 * `maple_id` to key the shared derivative cache and `fileinfo` to resolve where
 * that cache file lives.
 */
export async function findAssetAtAddress(
  libraryId: ObjectId,
  relPath: string,
  filename: string,
  dbOverride?: SqliteDb,
): Promise<AddressedAsset | null> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<{ id: string; maple_id: string | null }>(
    `SELECT a.id AS id, a.maple_id AS maple_id
       FROM asset_locations l
       JOIN assets a ON a.id = l.asset_id
      WHERE ${ADDRESS_WHERE} AND ${LIVE_ENTRY} AND a.deleted_at IS NULL
      LIMIT 1`,
    [libraryId.toHexString(), relPath, filename],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const locations = await db.read<LocationRow>(locationsByAssetIdsSql(1), [row.id]);
  return {
    _id: toObjectId(row.id),
    maple_id: row.maple_id,
    fileinfo: toFileInfo(locations),
  };
}

/**
 * The id of the asset holding a live entry at an address, or `null`.
 *
 * `routes/folders-file-ops.ts` refuses a path-addressed trash or relocate when
 * this answers, so the client is told which asset-keyed route to use instead.
 * "Live" here means both not replaced in place and not reaped, so a genuinely
 * new file that appeared where a reaped one used to be is not refused against a
 * stale row.
 */
export async function findLiveAssetIdAtAddress(
  libraryId: ObjectId,
  relPath: string,
  filename: string,
  dbOverride?: SqliteDb,
): Promise<ObjectId | null> {
  const rows = await sqliteDb(dbOverride).read<{ asset_id: string }>(
    `SELECT l.asset_id AS asset_id
       FROM asset_locations l
      WHERE ${ADDRESS_WHERE} AND ${LIVE_ENTRY}
      LIMIT 1`,
    [libraryId.toHexString(), relPath, filename],
  );
  const id = rows[0]?.asset_id;
  return id === undefined ? null : toObjectId(id);
}

/** The row an upload needs before it moves the file it is about to overwrite. */
export interface ReplaceableAsset {
  _id: ObjectId;
  sha1_head: string | null;
  size: number;
}

/**
 * The live asset an upload is about to overwrite, with the two fields that
 * decide whether the copy it moves to trash is worth keeping.
 *
 * Entry liveness is deliberately not part of the predicate, matching the
 * `$elemMatch` this replaces: the upload is identified by where the bytes are
 * going, and an entry the modified-content guard already tagged still names the
 * file that is sitting there.
 */
export async function findAssetToReplaceAtAddress(
  libraryId: ObjectId,
  relPath: string,
  filename: string,
  dbOverride?: SqliteDb,
): Promise<ReplaceableAsset | null> {
  const rows = await sqliteDb(dbOverride).read<{
    id: string;
    sha1_head: string | null;
    size: number;
  }>(
    `SELECT a.id AS id, a.sha1_head AS sha1_head, a.size AS size
       FROM asset_locations l
       JOIN assets a ON a.id = l.asset_id
      WHERE ${ADDRESS_WHERE} AND a.deleted_at IS NULL
      LIMIT 1`,
    [libraryId.toHexString(), relPath, filename],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { _id: toObjectId(row.id), sha1_head: row.sha1_head, size: row.size };
}

/** One indexed file in a directory, as the catalog-backed folder listing reads it. */
export interface DirectoryAsset {
  id: string;
  filename: string;
  maple_id: string | null;
  captured_at: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Every indexed asset whose live location sits directly in one directory of one
 * library — the catalog half of `GET /api/folder/:slug/*`.
 *
 * The library and the directory are columns of the same row, so an asset
 * deduplicated across libraries can only surface the filename it holds *here*.
 * On Mongo that guarantee needed `$elemMatch` and then a second pass in the
 * route to find which array entry had matched; here there is nothing to match
 * back up.
 */
export async function listDirectoryAssets(
  libraryId: ObjectId,
  relPath: string,
  dbOverride?: SqliteDb,
): Promise<DirectoryAsset[]> {
  return sqliteDb(dbOverride).read<DirectoryAsset>(
    `SELECT a.id AS id, l.filename AS filename, a.maple_id AS maple_id,
            a.captured_at AS captured_at,
            json_extract(a.exif, '$.width') AS width,
            json_extract(a.exif, '$.height') AS height
       FROM asset_locations l
       JOIN assets a ON a.id = l.asset_id
      WHERE l.library_id = ? AND l.path = ? AND ${LIVE_ENTRY} AND a.deleted_at IS NULL`,
    [libraryId.toHexString(), relPath],
  );
}

/** What an upload knows about the file it has just written into place. */
export interface UploadedAsset {
  libraryId: ObjectId;
  path: string;
  filename: string;
  size: number;
  /** `fs.stat().mtimeMs`, stored as the epoch-millisecond number the grid reads. */
  mtimeMs: number;
  indexedAt: string;
  mediaKind: 'image' | 'video' | 'audio';
  /** Stage names to seed at version 0, so the pipeline picks the asset up. */
  stages: readonly string[];
}

const UPDATE_UPLOADED_SQL = `
  UPDATE assets SET size = ?, mtime = ?, indexed_at = ?, deleted_at = NULL WHERE id = ?`;

const INSERT_UPLOADED_SQL = `
  INSERT INTO assets (id, size, mtime, indexed_at, media_kind) VALUES (?, ?, ?, ?, ?)`;

const INSERT_LOCATION_SQL = `
  INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename)
  VALUES (?, 0, ?, ?, ?)`;

const ID_AT_ADDRESS_SQL = `
  SELECT asset_id FROM asset_locations
   WHERE library_id = ? AND path = ? AND filename = ? LIMIT 1`;

/** Whether an insert failed because someone else claimed this address first. */
function isAddressConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:\s*asset_locations\./i.test(message);
}

/**
 * Create the asset for a freshly uploaded file, or bring the existing one up to
 * date — the SQLite shape of the route's `findOneAndUpdate(…, { upsert: true })`.
 *
 * The discover watcher may have noticed the same bytes first, so this has to
 * cooperate with a concurrent writer rather than assume it is alone. Reading the
 * address and then inserting is not atomic, so the insert can lose; when it does,
 * the UNIQUE index on `asset_locations` rejects it, this re-reads the address and
 * updates the row the winner created. That is the same outcome the Mongo upsert
 * produced by a different mechanism, and the retry cannot loop: the losing branch
 * only ever runs once, and an address that exists stays existing.
 *
 * The asset, its location and its stage rows go in one transaction, so a crash
 * cannot leave an asset the pipeline will never look at.
 */
export async function upsertUploadedAsset(
  input: UploadedAsset,
  dbOverride?: SqliteDb,
): Promise<ObjectId> {
  const db = sqliteDb(dbOverride);
  const address = [input.libraryId.toHexString(), input.path, input.filename];

  const existing = (await db.read<{ asset_id: string }>(ID_AT_ADDRESS_SQL, address))[0]?.asset_id;
  if (existing !== undefined) {
    await db.write(UPDATE_UPLOADED_SQL, [input.size, input.mtimeMs, input.indexedAt, existing]);
    return toObjectId(existing);
  }

  const id = newObjectIdHex();
  try {
    await db.transaction([
      {
        sql: INSERT_UPLOADED_SQL,
        params: [id, input.size, input.mtimeMs, input.indexedAt, input.mediaKind],
      },
      { sql: INSERT_LOCATION_SQL, params: [id, ...address] },
      ...seedStageRowStatements(id, input.stages),
    ]);
    return toObjectId(id);
  } catch (err) {
    if (!isAddressConflict(err)) throw err;
    const winner = (await db.read<{ asset_id: string }>(ID_AT_ADDRESS_SQL, address))[0]?.asset_id;
    if (winner === undefined) throw err;
    await db.write(UPDATE_UPLOADED_SQL, [input.size, input.mtimeMs, input.indexedAt, winner]);
    return toObjectId(winner);
  }
}
