/**
 * The backup routes' writes that put a photo's bytes on a location row: the
 * device link statement, the library-relative path split, and
 * {@link appendBackupLocation}. Split out of `backup.repo.ts` to keep it under
 * the file budget; that module re-exports what callers import.
 */

import path from 'node:path';
import { mediaKindOfFilenames } from '../../indexer/media-types.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import type { ObjectId } from '../object-id.ts';
import { relocateCacheRearmStatements } from './assets.stage-rearm.ts';
import { transactionUnlessPurged } from './backup-purge-guard.ts';
import { progressStatement, type ProgressArgs } from './backup-sessions.repo.ts';
import { toHex } from './values.ts';

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

/**
 * A library-relative path split the way `asset_locations` stores it: the
 * directory in POSIX form (`''` at the library root) and the filename.
 *
 * The separator normalisation is not decoration — a Windows host has `\` as
 * `path.sep`, and a directory stored with backslashes would never match the
 * forward-slash paths every other writer and reader in the schema uses.
 */
export function splitRelPath(relPath: string): { dir: string; filename: string } {
  const posix = relPath.split(path.sep).join('/');
  const dir = path.posix.dirname(posix);
  return {
    dir: dir === '.' || dir === '' ? '' : dir,
    filename: path.posix.basename(posix),
  };
}

/** The statement that records one device link. Idempotent: the table's
 * `UNIQUE (asset_id, device_id, phasset_local_id)` makes a repeat a no-op, so a
 * client retry cannot accumulate duplicates the way `$push` could. */
export function linkStatement(assetId: string, link: PhassetLink) {
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

interface AppendBackupLocationInput {
  /** Library-relative path the bytes landed at. */
  relPath: string;
  libraryId: ObjectId;
  /** The device link to record alongside it, or `null` when already linked. */
  link: PhassetLink | null;
  ownerId?: ObjectId | string | null;
  /** Replace this repaired location in place, retaining its ordinal. */
  replacedRelPath?: string | null;
  /** Counted in the same transaction as the location. */
  progress?: ProgressArgs;
}

/**
 * Cross-library dedup or missing-location repair: the content already exists as
 * an asset, so record this upload as a live location on it.
 *
 * Repair replaces the failed address in place, preserving its ordinal and
 * rearming path-keyed derivatives. Only reaper-deleted assets are revived.
 * A genuinely new location takes the next free `ordinal`, keeping `ordinal = 0`
 * meaning "the canonical entry". When re-materialising a copy at an existing
 * location row (e.g. one marked `missing_since` after its file was lost on
 * disk, #4700), the `(library_id, path, filename)` conflict re-activates that
 * row in place and clears `missing_since` / `missing_reason` / `deleted_at`.
 */
export async function appendBackupLocation(
  assetId: ObjectId,
  input: AppendBackupLocationInput,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const db = sqliteDb(dbOverride);
  const hex = toHex(assetId);
  const libHex = toHex(input.libraryId);
  const { dir, filename } = splitRelPath(input.relPath);
  const replaced = input.replacedRelPath ? splitRelPath(input.replacedRelPath) : null;
  const written = await transactionUnlessPurged(db, hex, [
    {
      sql: `UPDATE assets SET deleted_at = NULL, deleted_reason = NULL
            WHERE id = ? AND deleted_reason = 'reaped'`,
      params: [hex],
    },
    ...(replaced === null
      ? []
      : [
          {
            // The sibling's cloud-backup history follows the surviving ordinal. Where that
            // ordinal already has its own entry for the destination the sibling's is left as is.
            sql: `UPDATE backup_entries SET
                ordinal = (SELECT ordinal FROM asset_locations WHERE asset_id = ? AND library_id = ?
                  AND path = ? AND filename = ?),
                sequence = sequence + 1, snapshot_hash = NULL, retry_at = 0,
                lease_owner = NULL, lease_until = 0
              WHERE asset_id = ? AND ordinal = (SELECT ordinal FROM asset_locations
                  WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?
                    AND NOT (path = ? AND filename = ?))
                AND EXISTS (SELECT 1 FROM asset_locations WHERE asset_id = ? AND library_id = ?
                  AND path = ? AND filename = ?)
                AND NOT EXISTS (SELECT 1 FROM backup_entries kept
                  WHERE kept.destination_id = backup_entries.destination_id
                    AND kept.asset_id = backup_entries.asset_id
                    AND kept.ordinal = (SELECT ordinal FROM asset_locations WHERE asset_id = ?
                      AND library_id = ? AND path = ? AND filename = ?))`,
            params: [
              hex,
              libHex,
              replaced.dir,
              replaced.filename,
              hex,
              hex,
              libHex,
              dir,
              filename,
              replaced.dir,
              replaced.filename,
              hex,
              libHex,
              replaced.dir,
              replaced.filename,
              hex,
              libHex,
              replaced.dir,
              replaced.filename,
            ],
          },
          {
            // Coalesce an already-cataloged sibling before preserving the old ordinal.
            sql: `DELETE FROM asset_locations WHERE asset_id = ? AND library_id = ?
              AND path = ? AND filename = ? AND NOT (path = ? AND filename = ?)
              AND EXISTS (SELECT 1 FROM asset_locations old WHERE old.asset_id = ?
                AND old.library_id = ? AND old.path = ? AND old.filename = ?)`,
            params: [
              hex,
              libHex,
              dir,
              filename,
              replaced.dir,
              replaced.filename,
              hex,
              libHex,
              replaced.dir,
              replaced.filename,
            ],
          },
          {
            sql: `UPDATE asset_locations SET path = ?, filename = ?
            WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?`,
            params: [dir, filename, hex, libHex, replaced.dir, replaced.filename],
          },
        ]),
    {
      sql: `UPDATE asset_locations
               SET deleted_at = NULL, missing_since = NULL, missing_reason = NULL
             WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?`,
      params: [hex, libHex, dir, filename],
    },
    {
      sql: `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename)
            SELECT ?,
                   (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM (
                     SELECT ordinal FROM asset_locations WHERE asset_id = ? UNION ALL
                     SELECT ordinal FROM backup_entries WHERE asset_id = ?)),
                   ?, ?, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM asset_locations
                WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?
             )`,
      params: [hex, hex, hex, libHex, dir, filename, hex, libHex, dir, filename],
    },
    ...(replaced === null ? [] : relocateCacheRearmStatements(hex)),
    {
      // Match missing-reaper recovery: successful EXIF is still valid.
      sql: `UPDATE stage_state SET version = 0, attempts = 0, last_error = NULL,
              processed_at = NULL, dead = 0, next_attempt_at = NULL, claim_token = NULL
            WHERE asset_id = ? AND stage = 'exif' AND dead = 1`,
      params: [hex],
    },
    ...(input.link === null ? [] : [linkStatement(hex, input.link)]),
    ...(input.progress === undefined ? [] : [progressStatement(input.progress)]),
    ...(input.ownerId
      ? [
          {
            sql: `UPDATE assets SET owner_id = COALESCE(owner_id, ?) WHERE id = ?`,
            params: [toHex(input.ownerId), hex],
          },
        ]
      : []),
  ]);
  if (written) await refreshMediaKind(db, hex);
  return written;
}
