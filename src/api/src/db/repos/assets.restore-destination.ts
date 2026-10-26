/**
 * Who may hold the address a Trash restore moves a photo back to (#5425).
 *
 * A restore never overwrites a file, so the address it lands on held no file
 * a moment before. A catalog row can still claim it, and there are exactly
 * three kinds of claim:
 *
 *  - The restoring photo's own stale location. It names the file the restore
 *    just put there, so it merges into the restored location.
 *  - A row the folder watcher indexed for the restored file itself, between
 *    the move and the restore's own write. It goes, but only when it is
 *    provably that: the same content by hash and size, no other location, and
 *    nothing of its own — no faces, descriptions, edit history, people cover,
 *    Photos links or backups.
 *  - Anything else is another photo's row. It is never removed: the restore
 *    takes a suffixed name instead, and when the claim appears too late for
 *    that, the restore fails, keeps the photo in Trash and logs both ids.
 */

import * as path from 'node:path';
import type { ObjectId } from '../object-id.ts';
import type { SqlStatement } from '../sqlite/protocol.ts';
import { child as childLogger } from '../../log.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import type { LocationSource } from './assets.trash.ts';

const log = childLogger('assets-restore-destination');

const ASSERT_CONSTRAINT = 'restore_destination_unclaimed';

/** The restore's destination, as a library-relative `(path, filename)`. */
export interface RestoreDestination {
  libraryId: string;
  path: string;
  filename: string;
}

/**
 * Asset `d` is a watcher duplicate of the restoring photo. Binds the restoring
 * asset's id twice, then the restored file's size. Its rating, flag and label
 * are still the insert defaults, or were read from the restored sidecar and so
 * match the photo's own.
 */
const WATCHER_DUPLICATE = `d.deleted_at IS NULL AND d.hidden = 0 AND d.hidden_ack = 0
  AND d.place IS NULL AND d.apple_rendered_path IS NULL AND d.apple_live_video_path IS NULL
  AND d.sha1_head IS NOT NULL AND d.sha1_head = (SELECT sha1_head FROM assets WHERE id = ?)
  AND ((d.rating, d.flag, d.color_label) = (0, 0, '')
    OR (d.rating, d.flag, d.color_label) = (SELECT rating, flag, color_label FROM assets WHERE id = ?))
  AND d.size = ?
  AND (SELECT COUNT(*) FROM asset_locations WHERE asset_id = d.id) = 1
  AND NOT EXISTS (SELECT 1 FROM asset_locations WHERE asset_id = d.id
    AND (deleted_at IS NOT NULL OR missing_since IS NOT NULL))
  AND NOT EXISTS (SELECT 1 FROM faces WHERE asset_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM people WHERE cover_asset_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM asset_detail WHERE asset_id = d.id
    AND COALESCE(description, ocr_text, vision, transcript, video_description,
                 metadata_override, geo_inferred) IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM asset_subjects WHERE asset_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM person_segmentations WHERE asset_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM asset_phasset_links WHERE asset_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM sidecar_divergences WHERE asset_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM backup_sidecar_name_checks WHERE asset_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM backup_entries WHERE asset_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM backup_lifecycle WHERE asset_id = d.id)`;

/** Another asset's location at the destination. Binds the restoring asset's
 * id, then the destination. Alias `l`. */
const OTHER_ASSET_AT_DESTINATION = `l.asset_id <> ? AND l.library_id = ? AND l.path = ? AND l.filename = ?`;

const destinationParams = (d: RestoreDestination) => [d.libraryId, d.path, d.filename];

/**
 * The statements that clear the destination inside the restore's own
 * transaction, ahead of the repoint: merge the photo's own stale location,
 * drop a watcher duplicate, then refuse the commit if any other claim is left.
 */
export function clearRestoreDestinationStatements(
  assetId: string,
  destination: RestoreDestination,
  size: number,
  source: LocationSource | undefined,
): SqlStatement[] {
  const ownStale: SqlStatement[] = source
    ? [
        {
          sql: `DELETE FROM asset_locations
                 WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?
                   AND NOT (library_id = ? AND path = ? AND filename = ?)`,
          params: [
            assetId,
            ...destinationParams(destination),
            source.libraryId.toHexString(),
            source.path,
            source.filename,
          ],
        },
      ]
    : [];
  return [
    ...ownStale,
    {
      sql: `DELETE FROM assets AS d
             WHERE d.id IN (SELECT l.asset_id FROM asset_locations l
                             WHERE ${OTHER_ASSET_AT_DESTINATION})
               AND ${WATCHER_DUPLICATE}`,
      params: [assetId, ...destinationParams(destination), assetId, assetId, size],
    },
    {
      sql: `CREATE TEMP TABLE restore_destination_assert(
              valid INTEGER NOT NULL CONSTRAINT ${ASSERT_CONSTRAINT} CHECK (valid = 1))`,
    },
    {
      sql: `INSERT INTO restore_destination_assert(valid) SELECT NOT EXISTS
              (SELECT 1 FROM asset_locations l WHERE ${OTHER_ASSET_AT_DESTINATION})`,
      params: [assetId, ...destinationParams(destination)],
    },
    { sql: `DROP TABLE restore_destination_assert` },
  ];
}

/**
 * Turn the assertion failure into a logged error that names the destination.
 * Any other error is returned unchanged.
 */
export async function explainRestoreFailure(
  error: unknown,
  assetId: string,
  destination: RestoreDestination,
  dbOverride?: SqliteDb,
): Promise<unknown> {
  if (!(error instanceof Error) || !error.message.includes(ASSERT_CONSTRAINT)) return error;
  const occupants = await sqliteDb(dbOverride).read<{ asset_id: string }>(
    `SELECT l.asset_id FROM asset_locations l WHERE ${OTHER_ASSET_AT_DESTINATION}`,
    [assetId, ...destinationParams(destination)],
  );
  log.warn(
    { assetId, destination, occupants: occupants.map((row) => row.asset_id) },
    'restore: another photo claims the destination — both kept, the photo stays in Trash',
  );
  return new Error(
    `Restore destination ${path.posix.join(destination.path, destination.filename)} is claimed by another photo`,
  );
}

/**
 * Whether a restore candidate is claimed by another photo's row that the
 * restore may not remove, so the restore picks another name.
 */
export async function restoreDestinationClaimed(
  id: ObjectId,
  libraryId: ObjectId,
  relativePath: string,
  size: number,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const hex = id.toHexString();
  const dir = path.posix.dirname(relativePath);
  const destination = {
    libraryId: libraryId.toHexString(),
    path: dir === '.' ? '' : dir,
    filename: path.posix.basename(relativePath),
  };
  // COALESCE: a restoring photo with no recorded hash compares as NULL, and
  // NOT NULL would read as unclaimed.
  const [row] = await sqliteDb(dbOverride).read<{ claimed: number }>(
    `SELECT EXISTS(SELECT 1 FROM asset_locations l JOIN assets d ON d.id = l.asset_id
      WHERE ${OTHER_ASSET_AT_DESTINATION} AND NOT COALESCE((${WATCHER_DUPLICATE}), 0)) AS claimed`,
    [hex, ...destinationParams(destination), hex, hex, size],
  );
  return row?.claimed === 1;
}
