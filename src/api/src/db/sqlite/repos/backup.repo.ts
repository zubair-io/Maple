/**
 * `asset_phasset_links` and the backup routes' reads and writes over the asset
 * tables — the SQLite home for what `routes/backup-*.ts` used to spell inline
 * against the `assets` collection (#3787).
 *
 * ## Why this is its own module
 *
 * `asset_phasset_links` has no other owner: the two lookups keyed on it that
 * already existed (`findLiveAssetIdByMapleId`, `findLiveAssetIdByPhassetLink`)
 * live in `assets.repo.ts` because the sidecar route asks them of an *asset*.
 * Everything here asks about the backup relationship itself — which iCloud
 * photos a device has sent, which of them the library already holds, and where
 * their bytes landed — so it belongs beside the table that records it rather
 * than folded into the assets read module, which answers a different question
 * and is already at the size where it wants splitting rather than growing.
 *
 * ## Same-entry matching, and why the counts still agree
 *
 * Several of these queries replace a Mongo `$elemMatch` over `fileinfo[]` or
 * `phasset_links[]`. An entry is a row here, so "one entry satisfies all of
 * these conditions" is a `WHERE` on a single row and "any entry satisfies each"
 * is an explicit `EXISTS` — the distinction that was invisible at the Mongo
 * call site is now the shape of the statement. Where the Mongo filter used
 * dotted paths deliberately (notify-deleted scopes by *any* location in the
 * library, live or not), the `EXISTS` here says so explicitly.
 *
 * {@link markDeletedFromPhotos} additionally excludes rows that are already
 * flagged. Mongo reports `modifiedCount`, which counts only documents whose
 * bytes changed; SQLite's `changes()` counts every row the statement touched.
 * Without the extra predicate a device re-reporting the same deletions would be
 * told it updated them again.
 */

import path from 'node:path';
import { ObjectId } from 'mongodb';
import { newObjectIdHex } from '../object-id.ts';
import { classifyMediaType, mediaKindOfFilenames } from '../../../indexer/media-types.ts';
import { sqliteDb, updateOutcome, type SqliteDb, type UpdateOutcome } from './db-handle.ts';
import { nowIso, placeholders, toHex } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/**
 * One device's link to an Apple Photos asset, as the backup routes build it.
 *
 * `first_seen` is a `Date` because that is what the routes construct and what
 * the Mongo document declared; the column is ISO text, like every other
 * timestamp in this schema.
 */
export interface PhassetLink {
  device_id: string;
  phasset_local_id: string;
  phasset_cloud_id?: string;
  first_seen: Date;
}

/** `<path>/<filename>`, or just the filename at the library root. */
const REL_PATH_EXPRESSION = `CASE WHEN l.path = '' THEN l.filename ELSE l.path || '/' || l.filename END`;

/**
 * A library-relative path split the way `asset_locations` stores it: the
 * directory in POSIX form (`''` at the library root) and the filename.
 *
 * The separator normalisation is not decoration — a Windows host has `\` as
 * `path.sep`, and a directory stored with backslashes would never match the
 * forward-slash paths every other writer and reader in the schema uses.
 */
function splitRelPath(relPath: string): { dir: string; filename: string } {
  const posix = relPath.split(path.sep).join('/');
  const dir = path.posix.dirname(posix);
  return {
    dir: dir === '.' || dir === '' ? '' : dir,
    filename: path.posix.basename(posix),
  };
}

/** The library-relative path of an asset's first live location in a library. */
const LIVE_REL_PATH_SUBQUERY = `
  (SELECT ${REL_PATH_EXPRESSION}
     FROM asset_locations l
    WHERE l.asset_id = a.id AND l.library_id = ? AND l.deleted_at IS NULL
    ORDER BY l.ordinal LIMIT 1)`;

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/**
 * Which of these content ids the library already holds, live.
 *
 * Backs the batch dedup probe the device runs before uploading. Scoped to a
 * live location (`deleted_at IS NULL`) so a photo the user trashed is reported
 * absent and gets re-uploaded rather than silently skipped forever.
 */
export async function findMapleIdsPresentInLibrary(
  mapleIds: readonly string[],
  libraryId: ObjectId,
  dbOverride?: SqliteDb,
): Promise<Set<string>> {
  if (mapleIds.length === 0) return new Set();
  const rows = await sqliteDb(dbOverride).read<{ maple_id: string }>(
    `SELECT DISTINCT a.maple_id AS maple_id
       FROM assets a
       JOIN asset_locations l ON l.asset_id = a.id
      WHERE a.maple_id IN (${placeholders(mapleIds.length)})
        AND l.library_id = ? AND l.deleted_at IS NULL`,
    [...mapleIds, toHex(libraryId)],
  );
  return new Set(rows.map((row) => row.maple_id));
}

/** What the ingest route needs to know about an asset that already holds this
 * content — see {@link findIngestDedupTarget}. */
export interface IngestDedupTarget {
  /** The existing asset. */
  id: ObjectId;
  /**
   * Library-relative path of its first live location *in this library*, or
   * `null` when the content lives only in some other library. `null` is what
   * makes the ingest route materialise a second copy here instead of
   * pure-deduplicating.
   */
  liveRelPathInLibrary: string | null;
  /** Whether this device's PHAsset is already linked to the asset. */
  alreadyLinked: boolean;
}

/**
 * The asset that already carries this content id, if any, answered together
 * with the two facts the ingest route branches on.
 *
 * Deliberately *not* library-scoped, exactly as the `findOne({ maple_id })` it
 * replaces: `maple_id` is a global content hash, and a match in another library
 * is the cross-library case the route materialises a copy for. The library
 * appears only in the sub-select that decides which case this is.
 */
export async function findIngestDedupTarget(
  args: {
    mapleId: string;
    libraryId: ObjectId;
    deviceId: string;
    phassetLocalId: string;
  },
  dbOverride?: SqliteDb,
): Promise<IngestDedupTarget | null> {
  const rows = await sqliteDb(dbOverride).read<{
    id: string;
    live_rel_path: string | null;
    already_linked: number;
  }>(
    `SELECT a.id AS id,
            ${LIVE_REL_PATH_SUBQUERY} AS live_rel_path,
            EXISTS (SELECT 1 FROM asset_phasset_links p
                     WHERE p.asset_id = a.id AND p.device_id = ? AND p.phasset_local_id = ?)
              AS already_linked
       FROM assets a
      WHERE a.maple_id = ?
      LIMIT 1`,
    [toHex(args.libraryId), args.deviceId, args.phassetLocalId, args.mapleId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: new ObjectId(row.id),
    liveRelPathInLibrary: row.live_rel_path,
    alreadyLinked: row.already_linked === 1,
  };
}

/** One row of the device reconciliation feed. */
export interface BackupStateEntry {
  phasset_local_id: string;
  first_seen: string;
  maple_id: string | null;
  rel_path: string;
}

/**
 * Everything this device has sent to this library since `since`.
 *
 * The device calls it on launch to learn which of its photos are already backed
 * up. An asset with no live location in this library is left out — its bytes
 * are not here, so telling the device it is backed up would lose the photo.
 *
 * ISO-8601 timestamps compare lexicographically in the order they compare
 * chronologically, so `first_seen >= ?` is the `{ $gte: since }` it replaces;
 * both sides are produced by `Date#toISOString`, which is fixed-width.
 */
export async function listBackupState(
  libraryId: ObjectId,
  deviceId: string,
  since: Date,
  dbOverride?: SqliteDb,
): Promise<BackupStateEntry[]> {
  const library = toHex(libraryId);
  return await sqliteDb(dbOverride).read<BackupStateEntry>(
    `SELECT p.phasset_local_id AS phasset_local_id,
            p.first_seen AS first_seen,
            a.maple_id AS maple_id,
            ${LIVE_REL_PATH_SUBQUERY} AS rel_path
       FROM asset_phasset_links p
       JOIN assets a ON a.id = p.asset_id
      WHERE p.device_id = ? AND p.first_seen >= ?
        AND EXISTS (SELECT 1 FROM asset_locations l
                     WHERE l.asset_id = a.id AND l.library_id = ? AND l.deleted_at IS NULL)`,
    [library, deviceId, since.toISOString(), library],
  );
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

/** The statement that records one device link. Idempotent: the table's
 * `UNIQUE (asset_id, device_id, phasset_local_id)` makes a repeat a no-op, so a
 * client retry cannot accumulate duplicates the way `$push` could. */
function linkStatement(assetId: string, link: PhassetLink) {
  return {
    sql: `INSERT OR IGNORE INTO asset_phasset_links
            (asset_id, device_id, phasset_local_id, phasset_cloud_id, first_seen)
          VALUES (?, ?, ?, ?, ?)`,
    params: [
      assetId,
      link.device_id,
      link.phasset_local_id,
      link.phasset_cloud_id ?? null,
      link.first_seen.toISOString(),
    ],
  };
}

/** Record this device's PHAsset against an asset the library already holds. */
export async function linkPhasset(
  assetId: ObjectId,
  link: PhassetLink,
  dbOverride?: SqliteDb,
): Promise<void> {
  const statement = linkStatement(toHex(assetId), link);
  await sqliteDb(dbOverride).write(statement.sql, statement.params);
}

/**
 * Recompute `media_kind` from the asset's live locations.
 *
 * The Mongo twin (`updateLiveLocationCount`) recomputed the live count in the
 * same pipeline; here the count is maintained by the `asset_locations` triggers,
 * so only the media kind is left. It stays in TypeScript rather than SQL
 * because the extension lists live in `indexer/media-types.ts` and a second
 * copy in a `CASE` expression is a copy that drifts.
 *
 * Why it matters on this path: a Live Photo backup lands `still.HEIC` and
 * `clip.MOV` on one asset, and the row has to become `video` for the media
 * stages and migrations to see it at all.
 */
async function refreshMediaKind(db: SqliteDb, assetId: string): Promise<void> {
  const rows = await db.read<{ filename: string }>(
    `SELECT filename FROM asset_locations
      WHERE asset_id = ? AND deleted_at IS NULL AND missing_since IS NULL`,
    [assetId],
  );
  if (rows.length === 0) return;
  await db.write(`UPDATE assets SET media_kind = ? WHERE id = ?`, [
    mediaKindOfFilenames(rows.map((row) => row.filename)),
    assetId,
  ]);
}

export interface AppendBackupLocationInput {
  /** Library-relative path the bytes landed at. */
  relPath: string;
  libraryId: ObjectId;
  /** The device link to record alongside it, or `null` when already linked. */
  link: PhassetLink | null;
}

/**
 * Cross-library dedup: the content already exists as an asset, so record this
 * upload as one more location on it.
 *
 * The new row takes the next free `ordinal`, which is what keeps `ordinal = 0`
 * meaning "the canonical entry" — appending is the `$push` it replaces, not a
 * replacement of the primary.
 */
export async function appendBackupLocation(
  assetId: ObjectId,
  input: AppendBackupLocationInput,
  dbOverride?: SqliteDb,
): Promise<void> {
  const db = sqliteDb(dbOverride);
  const hex = toHex(assetId);
  const { dir, filename } = splitRelPath(input.relPath);
  await db.transaction([
    {
      sql: `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename)
            SELECT ?, COALESCE(MAX(ordinal), -1) + 1, ?, ?, ?
              FROM asset_locations WHERE asset_id = ?`,
      params: [hex, toHex(input.libraryId), dir, filename, hex],
    },
    ...(input.link === null ? [] : [linkStatement(hex, input.link)]),
  ]);
  await refreshMediaKind(db, hex);
}

export interface InsertBackupAssetInput {
  /** Library-relative path the bytes landed at. */
  relPath: string;
  libraryId: ObjectId;
  totalBytes: number;
  mapleId: string;
  isScreenshot: boolean;
  link: PhassetLink;
}

/**
 * First upload of this content: create the asset, its one location and the
 * device link, in one transaction.
 *
 * `live_location_count` is not written — the `asset_locations` insert trigger
 * sets it, which is the same value the Mongo insert hard-coded and one fewer
 * thing that can disagree with the table it summarises.
 */
export async function insertBackupAsset(
  input: InsertBackupAssetInput,
  dbOverride?: SqliteDb,
): Promise<ObjectId> {
  const id = newObjectIdHex();
  const { dir, filename } = splitRelPath(input.relPath);
  await sqliteDb(dbOverride).transaction([
    {
      sql: `INSERT INTO assets
              (id, size, mtime, indexed_at, rating, flag, color_label, media_kind,
               is_screenshot, maple_id, deleted_from_photos)
            VALUES (?, ?, ?, ?, 0, 0, '', ?, ?, ?, 0)`,
      params: [
        id,
        input.totalBytes,
        Date.now(),
        nowIso(),
        classifyMediaType(filename),
        input.isScreenshot ? 1 : 0,
        input.mapleId,
      ],
    },
    {
      sql: `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename)
            VALUES (?, 0, ?, ?, ?)`,
      params: [id, toHex(input.libraryId), dir, filename],
    },
    linkStatement(id, input.link),
  ]);
  return new ObjectId(id);
}

/**
 * Flag the assets a device reports gone from Apple Photos. The rows stay — we
 * keep the bytes; only the "still in Photos" claim changes.
 *
 * Scoped by *any* location in this library rather than a live one, which is
 * what the dotted `'fileinfo.library_id'` filter meant: a photo the user
 * deleted from Photos is still a photo this library backed up.
 */
export async function markDeletedFromPhotos(
  libraryId: ObjectId,
  deviceId: string,
  phassetLocalIds: readonly string[],
  dbOverride?: SqliteDb,
): Promise<number> {
  if (phassetLocalIds.length === 0) return 0;
  const result = await sqliteDb(dbOverride).write(
    `UPDATE assets SET deleted_from_photos = 1
      WHERE deleted_from_photos = 0
        AND EXISTS (SELECT 1 FROM asset_locations l
                     WHERE l.asset_id = assets.id AND l.library_id = ?)
        AND EXISTS (SELECT 1 FROM asset_phasset_links p
                     WHERE p.asset_id = assets.id AND p.device_id = ?
                       AND p.phasset_local_id IN (${placeholders(phassetLocalIds.length)}))`,
    [toHex(libraryId), deviceId, ...phassetLocalIds],
  );
  return result.changes;
}

/**
 * Point an asset at the Apple-rendered companion that was just uploaded beside
 * it.
 *
 * One row, chosen by the same `(maple_id, this library)` pair the Mongo
 * `updateOne` matched on. The inner `LIMIT 1` is what keeps it `updateOne`
 * rather than `updateMany`: two libraries can hold the same content, and only
 * the one the companion was uploaded to should learn about it.
 */
export async function setAppleRenderedPath(
  libraryId: ObjectId,
  mapleId: string,
  relPath: string,
  dbOverride?: SqliteDb,
): Promise<UpdateOutcome> {
  const result = await sqliteDb(dbOverride).write(
    `UPDATE assets SET apple_rendered_path = ?
      WHERE id = (SELECT a.id FROM assets a
                   WHERE a.maple_id = ?
                     AND EXISTS (SELECT 1 FROM asset_locations l
                                  WHERE l.asset_id = a.id AND l.library_id = ?)
                   LIMIT 1)`,
    [relPath, mapleId, toHex(libraryId)],
  );
  return updateOutcome(result.changes);
}
