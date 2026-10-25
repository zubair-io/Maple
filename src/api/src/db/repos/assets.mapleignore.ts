/**
 * The read behind the `.mapleignore` exclusion pass (#5398,
 * `workers/discover/folder-ignore.ts`): the live locations an ignored
 * directory still holds, so each can be tagged missing through the ordinary
 * `tagLocationMissing` verb.
 *
 * Steady state matters as much as the first pass. Once a folder's locations
 * are tagged they stop being live, so every later sweep's visit to the marked
 * directory matches nothing here and writes nothing.
 */

import type { ObjectId } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toHex } from './values.ts';

export interface IgnoredLiveLocation {
  /** Location row id — the keyset the pass pages by. */
  id: number;
  path: string;
  filename: string;
}

/**
 * The directory itself or any descendant, spelled as a range rather than a
 * `substr` prefix test so the `(library_id, path, filename)` index can seek.
 * `'0'` is the character after `'/'`, so `[rel/, rel0)` is exactly the paths
 * starting `rel/` — a sibling such as `photos2` is not under `photos`.
 */
function subtreePredicate(relDir: string): { sql: string; params: string[] } {
  if (relDir === '') return { sql: '1', params: [] };
  return {
    sql: '(l.path = ? OR (l.path >= ? AND l.path < ?))',
    params: [relDir, `${relDir}/`, `${relDir}0`],
  };
}

/**
 * Live locations of non-trashed assets in `relDir` and its subtree, in
 * location-id order after `afterId`. Trashed assets are left alone: their
 * locations already point into `.maple/trash/`, which belongs to the trash
 * retention window, not to the folder they came from.
 */
export async function listLiveLocationsUnder(
  libraryId: ObjectId,
  relDir: string,
  afterId: number,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<IgnoredLiveLocation[]> {
  const subtree = subtreePredicate(relDir);
  return sqliteDb(dbOverride).read<IgnoredLiveLocation>(
    `SELECT l.id, l.path, l.filename
       FROM asset_locations l
       JOIN assets a ON a.id = l.asset_id
      WHERE l.library_id = ? AND ${subtree.sql}
        AND l.deleted_at IS NULL AND l.missing_since IS NULL
        AND a.deleted_at IS NULL
        AND l.id > ?
      ORDER BY l.id
      LIMIT ?`,
    [toHex(libraryId), ...subtree.params, afterId, limit],
  );
}
