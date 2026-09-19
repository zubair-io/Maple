/**
 * Collapsing two asset rows that turn out to hold the same content (#3787).
 *
 * The EXIF stage is the caller. It upgrades an asset's `maple_id` from the
 * discover watcher's fallback form to the primary form derived from the capture
 * date, and occasionally the primary id is already taken — a third copy of the
 * same file that slipped past the discover dedup. `maple_id` is UNIQUE, so the
 * upgrade cannot simply be written; the two rows have to become one first.
 *
 * ## What the rows fix that the documents could not
 *
 * The Mongo merge is four unrelated writes — patch the survivor, `$push` each of
 * the loser's `fileinfo` entries, delete the loser, then claim the id — and it is
 * explicitly documented as non-atomic, healing by being idempotent on the next
 * retry. Here it is one transaction, so the intermediate states are unreachable.
 *
 * Three of its hazards disappear outright:
 *
 *  - **The id claim no longer needs to come last.** On Mongo, writing
 *    `maple_id` onto the survivor before deleting the loser collides on the
 *    unique index (E11000 — the failure that dead-lettered duplicate uploads),
 *    so the update was ordered strictly after the delete and a crash in between
 *    left the survivor on its fallback id. Inside one transaction the delete
 *    frees the key for the statement after it, and nothing can observe the gap.
 *  - **There is no "entry already present" case.** `asset_locations_lib_path_name`
 *    is UNIQUE over `(library_id, path, filename)` across the whole table, so two
 *    assets cannot claim the same file and the loser's entries can only be new to
 *    the survivor. The Mongo version needed a conditional `$push`, then an
 *    `arrayFilters` pass to revive a tombstone the survivor was holding for the
 *    same path; both are unreachable here.
 *  - **`live_location_count` maintains itself.** The update trigger on
 *    `asset_locations` handles a row moving between assets (see
 *    `../ddl/asset-locations.ts`), so the roll-up lands in the same transaction
 *    instead of needing the explicit recompute the Mongo path calls twice.
 */

import type { SqlStatement } from '../protocol.ts';
import type { AssetExif, FileInfo } from '../../schema.ts';
import { toFileInfo, type LocationRow } from './assets.rows.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';

/** The row already holding a `maple_id`, with everything the merge compares. */
export interface MapleIdHolder {
  id: string;
  indexed_at: string;
  rating: number;
  flag: number;
  color_label: string;
  /** Whether the row already carries a parsed EXIF payload. */
  hasExif: boolean;
  fileinfo: FileInfo[];
}

/**
 * The other asset holding `mapleId`, or `null` when the id is free.
 *
 * `maple_id IS NOT NULL` beside the equality is not redundant: `assets_maple_id`
 * is a UNIQUE partial index over that predicate, and SQLite only uses a partial
 * index when the query's own `WHERE` provably implies it — which `maple_id = ?`
 * alone does not, because the bound value is unknown at planning time. Without
 * it this probe is a scan of the whole table, once per EXIF-stage upgrade.
 */
export async function findMapleIdHolder(
  mapleId: string,
  excludingAssetId: string,
  dbOverride?: SqliteDb,
): Promise<MapleIdHolder | null> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<{
    id: string;
    indexed_at: string;
    rating: number;
    flag: number;
    color_label: string;
    has_exif: number;
  }>(
    `SELECT id, indexed_at, rating, flag, color_label,
            CASE WHEN exif IS NULL THEN 0 ELSE 1 END AS has_exif
       FROM assets
      WHERE maple_id = ? AND maple_id IS NOT NULL AND id <> ?
      LIMIT 1`,
    [mapleId, excludingAssetId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const locations = await db.read<LocationRow>(
    `SELECT asset_id, ordinal, library_id, path, filename,
            deleted_at, missing_since, missing_reason, keep
       FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`,
    [row.id],
  );
  return {
    id: row.id,
    indexed_at: row.indexed_at,
    rating: row.rating,
    flag: row.flag,
    color_label: row.color_label,
    hasExif: row.has_exif === 1,
    fileinfo: toFileInfo(locations),
  };
}

/** The user-set fields carried across when the survivor still holds defaults. */
export interface MergeCarryOver {
  rating?: number;
  flag?: number;
  colorLabel?: string;
  /** The EXIF this run parsed, written only when the survivor has none. */
  exif?: AssetExif | null;
  isScreenshot?: boolean;
}

/**
 * Fold the condemned row into the survivor and claim `mapleId` for it, in one
 * transaction.
 *
 * `ordinalOffset` is read before the transaction rather than computed inside the
 * `UPDATE`, because a subquery over `MAX(ordinal)` would be re-evaluated per row
 * against a set the same statement is changing. One read, then a statement that
 * shifts every one of the condemned's ordinals by a constant — which keeps their
 * relative order and cannot collide with the survivor's, satisfying
 * `UNIQUE (asset_id, ordinal)`.
 *
 * Deleting the condemned row cascades its faces, detail payload, search row,
 * phasset links and stage bookkeeping. Its locations have already moved, so the
 * cascade takes nothing the survivor needs.
 */
export async function mergeIntoSurvivor(args: {
  survivorId: string;
  condemnedId: string;
  mapleId: string;
  carryOver?: MergeCarryOver;
  dbOverride?: SqliteDb;
}): Promise<void> {
  const db = sqliteDb(args.dbOverride);
  const offsets = await db.read<{ next_ordinal: number }>(
    `SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
       FROM asset_locations WHERE asset_id = ?`,
    [args.survivorId],
  );
  const ordinalOffset = offsets[0]?.next_ordinal ?? 0;

  await db.transaction([
    ...carryOverStatements(args.survivorId, args.carryOver ?? {}),
    {
      sql: `UPDATE asset_locations SET asset_id = ?, ordinal = ordinal + ? WHERE asset_id = ?`,
      params: [args.survivorId, ordinalOffset, args.condemnedId],
    },
    { sql: `DELETE FROM assets WHERE id = ?`, params: [args.condemnedId] },
    // Strictly after the delete, which is what frees the unique key — but inside
    // the same transaction, so no crash can leave the survivor on its fallback id.
    { sql: `UPDATE assets SET maple_id = ? WHERE id = ?`, params: [args.mapleId, args.survivorId] },
  ]);
}

/** The survivor's field promotions, as one statement or none. */
function carryOverStatements(survivorId: string, carry: MergeCarryOver): SqlStatement[] {
  const columns: string[] = [];
  const params: (string | number | null)[] = [];
  if (carry.rating !== undefined) {
    columns.push('rating = ?');
    params.push(carry.rating);
  }
  if (carry.flag !== undefined) {
    columns.push('flag = ?');
    params.push(carry.flag);
  }
  if (carry.colorLabel !== undefined) {
    columns.push('color_label = ?');
    params.push(carry.colorLabel);
  }
  if (carry.exif !== undefined) {
    columns.push('exif = ?');
    params.push(carry.exif === null ? null : JSON.stringify(carry.exif));
  }
  if (carry.isScreenshot !== undefined) {
    columns.push('is_screenshot = ?');
    params.push(carry.isScreenshot ? 1 : 0);
  }
  if (columns.length === 0) return [];
  return [
    {
      sql: `UPDATE assets SET ${columns.join(', ')} WHERE id = ?`,
      params: [...params, survivorId],
    },
  ];
}
