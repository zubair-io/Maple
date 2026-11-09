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

import { ObjectId } from '../object-id.ts';
import { newObjectIdHex } from '../object-id.ts';
import { classifyMediaType } from '../../indexer/media-types.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { ALL_STAGE_NAMES } from '../../workers/stages/stage-names.ts';
import { seedStageRowStatements } from './stage-state.repo.ts';
import { transactionUnlessPurged } from './backup-purge-guard.ts';
import { progressStatement, type ProgressArgs } from './backup-sessions.repo.ts';
import { linkStatement, splitRelPath, type PhassetLink } from './backup-location.repo.ts';
import { nowIso, placeholders, toHex } from './values.ts';

export { appendBackupLocation, type PhassetLink } from './backup-location.repo.ts';

export type { SqliteDb } from './db-handle.ts';

/** `<path>/<filename>`, or just the filename at the library root. */
const REL_PATH_EXPRESSION = `CASE WHEN l.path = '' THEN l.filename ELSE l.path || '/' || l.filename END`;

/** The library-relative path of an asset's first live location in a library. */
const LIVE_REL_PATH_SUBQUERY = `
  (SELECT ${REL_PATH_EXPRESSION}
     FROM asset_locations l
    WHERE l.asset_id = a.id AND l.library_id = ?
      AND l.deleted_at IS NULL AND l.missing_since IS NULL
    ORDER BY l.ordinal LIMIT 1)`;

/** The library-relative path of an asset's first missing location in a library. */
const MISSING_REL_PATH_SUBQUERY = `
  (SELECT ${REL_PATH_EXPRESSION}
     FROM asset_locations l
    WHERE l.asset_id = a.id AND l.library_id = ?
      AND l.deleted_at IS NULL AND l.missing_since IS NOT NULL
    ORDER BY l.ordinal LIMIT 1)`;

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/**
 * Which of these content ids the library already holds, live.
 *
 * Backs the batch dedup probe the device runs before uploading. Scoped to a
 * live location (`deleted_at IS NULL AND missing_since IS NULL`) so a photo
 * the user trashed or whose on-disk copy was lost is reported absent and gets
 * re-uploaded rather than silently skipped forever.
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
        AND l.library_id = ? AND l.deleted_at IS NULL AND l.missing_since IS NULL`,
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
   * `null` when the content has no live location here. `null` is what makes
   * the ingest route materialise a copy here instead of pure-deduplicating.
   */
  liveRelPathInLibrary: string | null;
  /**
   * Library-relative path of its first missing (non-deleted) location *in this
   * library*, or `null` when none exists. When re-materialising a lost copy,
   * the ingest route restores the bytes to this path so the existing location
   * row can be re-activated in place (#4700).
   */
  missingRelPathInLibrary: string | null;
  /** Whether this device's PHAsset is already linked to the asset. */
  alreadyLinked: boolean;
  /** A durable purge intent owns this identity, even before physical deletion. */
  purgeAdmitted: boolean;
}

/**
 * The asset that already carries this content id, if any, answered together
 * with the facts the ingest route branches on.
 *
 * Deliberately *not* library-scoped, exactly as the `findOne({ maple_id })` it
 * replaces: `maple_id` is a global content hash, and a match in another library
 * is the cross-library case the route materialises a copy for. The library
 * appears only in the sub-selects that decide which case this is.
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
  const libHex = toHex(args.libraryId);
  const rows = await sqliteDb(dbOverride).read<{
    id: string;
    live_rel_path: string | null;
    missing_rel_path: string | null;
    already_linked: number;
    purge_admitted: number;
  }>(
    `SELECT a.id AS id,
            ${LIVE_REL_PATH_SUBQUERY} AS live_rel_path,
            ${MISSING_REL_PATH_SUBQUERY} AS missing_rel_path,
            EXISTS (SELECT 1 FROM asset_phasset_links p
                     WHERE p.asset_id = a.id AND p.device_id = ? AND p.phasset_local_id = ?)
              AS already_linked,
            EXISTS (SELECT 1 FROM backup_lifecycle b
                     WHERE b.asset_id = a.id AND b.kind = 'purge') AS purge_admitted
       FROM assets a
      WHERE a.maple_id = ?
      LIMIT 1`,
    [libHex, libHex, args.deviceId, args.phassetLocalId, args.mapleId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: new ObjectId(row.id),
    liveRelPathInLibrary: row.live_rel_path,
    missingRelPathInLibrary: row.missing_rel_path,
    alreadyLinked: row.already_linked === 1,
    purgeAdmitted: row.purge_admitted === 1,
  };
}

/**
 * Whether `(libraryId, relPath)` in `asset_locations` is already claimed by an
 * asset other than `assetId`. Used before placing or adopting a file on disk so
 * a cross-library or repair upload disambiguates instead of colliding with
 * another asset's location row.
 */
export async function isLocationOwnedByOtherAsset(
  libraryId: ObjectId,
  relPath: string,
  assetId?: ObjectId,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const { dir, filename } = splitRelPath(relPath);
  const rows = await sqliteDb(dbOverride).read<{ asset_id: string }>(
    `SELECT asset_id FROM asset_locations
      WHERE library_id = ? AND path = ? AND filename = ?
      LIMIT 1`,
    [toHex(libraryId), dir, filename],
  );
  const row = rows[0];
  if (row === undefined) return false;
  return assetId === undefined || row.asset_id !== toHex(assetId);
}

/** Whether `relPath` is a live location of `assetId` in this library, so a
 * write addressed to it really targets that asset's file (#4719). */
export async function isLiveLocationOfAsset(
  assetId: ObjectId,
  libraryId: ObjectId,
  relPath: string,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const { dir, filename } = splitRelPath(relPath);
  const rows = await sqliteDb(dbOverride).read<{ one: number }>(
    `SELECT 1 AS one FROM asset_locations
      WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?
        AND deleted_at IS NULL AND missing_since IS NULL
      LIMIT 1`,
    [toHex(assetId), toHex(libraryId), dir, filename],
  );
  return rows.length > 0;
}

/** One row of the device reconciliation feed. */
export interface BackupStateEntry {
  phasset_local_id: string;
  first_seen: string;
  maple_id: string | null;
  rel_path: string;
  /** The asset has a Live Photo video recorded beside it. */
  has_live_video: boolean;
  /** The asset has an Apple-rendered edit recorded beside it. */
  has_rendered: boolean;
}

/**
 * Everything this device has sent to this library since `since`.
 *
 * The device calls it on launch to learn which of its photos are already backed
 * up. An asset with no live location in this library is left out — its bytes
 * are not here, so telling the device it is backed up would lose the photo.
 * Each row also says which companions the asset has recorded, so a device can
 * re-send a Live Photo video or edited render an earlier client dropped.
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
  // Both LIVE_REL_PATH_SUBQUERY and the EXISTS guard filter
  // `l.deleted_at IS NULL AND l.missing_since IS NULL`, so a missing ordinal-0
  // row is skipped in favour of the first live ordinal (#4700).
  const rows = await sqliteDb(dbOverride).read<
    Omit<BackupStateEntry, 'has_live_video' | 'has_rendered'> & {
      has_live_video: number;
      has_rendered: number;
    }
  >(
    `SELECT p.phasset_local_id AS phasset_local_id,
            p.first_seen AS first_seen,
            a.maple_id AS maple_id,
            ${LIVE_REL_PATH_SUBQUERY} AS rel_path,
            a.apple_live_video_path IS NOT NULL AS has_live_video,
            a.apple_rendered_path IS NOT NULL AS has_rendered
       FROM asset_phasset_links p
       JOIN assets a ON a.id = p.asset_id
      WHERE p.device_id = ? AND p.first_seen >= ?
        AND EXISTS (SELECT 1 FROM asset_locations l
                     WHERE l.asset_id = a.id AND l.library_id = ?
                       AND l.deleted_at IS NULL AND l.missing_since IS NULL)`,
    [library, deviceId, since.toISOString(), library],
  );
  return rows.map((row) => ({
    ...row,
    has_live_video: row.has_live_video === 1,
    has_rendered: row.has_rendered === 1,
  }));
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

/** Record this device's PHAsset against an asset the library already holds;
 * false when a purge intent owns it. */
export async function linkPhasset(
  assetId: ObjectId,
  link: PhassetLink,
  dbOverride?: SqliteDb,
  progress?: ProgressArgs,
): Promise<boolean> {
  const hex = toHex(assetId);
  return transactionUnlessPurged(sqliteDb(dbOverride), hex, [
    linkStatement(hex, link),
    ...(progress === undefined ? [] : [progressStatement(progress)]),
  ]);
}

export interface InsertBackupAssetInput {
  /** Library-relative path the bytes landed at. */
  relPath: string;
  libraryId: ObjectId;
  totalBytes: number;
  mapleId: string;
  isScreenshot: boolean;
  link: PhassetLink;
  ownerId?: ObjectId | string | null;
  /** Counted in the same transaction as the asset. */
  progress?: ProgressArgs;
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
               is_screenshot, maple_id, deleted_from_photos, owner_id)
            VALUES (?, ?, ?, ?, 0, 0, '', ?, ?, ?, 0,
              COALESCE(?, (SELECT id FROM users WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1)))`,
      params: [
        id,
        input.totalBytes,
        Date.now(),
        nowIso(),
        classifyMediaType(filename),
        input.isScreenshot ? 1 : 0,
        input.mapleId,
        input.ownerId ? toHex(input.ownerId) : null,
      ],
    },
    {
      sql: `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename)
            VALUES (?, 0, ?, ?, ?)`,
      params: [id, toHex(input.libraryId), dir, filename],
    },
    linkStatement(id, input.link),
    ...(input.progress === undefined ? [] : [progressStatement(input.progress)]),
    ...seedStageRowStatements(id, ALL_STAGE_NAMES),
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
