/**
 * The read behind the `.mapleignore` exclusion pass (#5398,
 * `workers/discover/folder-ignore.ts`): the live locations an ignored
 * directory still holds. Once they are tagged they stop being live, so every
 * later visit matches nothing and writes nothing.
 */

import type { ObjectId } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toHex } from './values.ts';

export interface IgnoredLiveLocation {
  path: string;
  filename: string;
}

/**
 * A run of `path` values the `(library_id, path, filename)` index can seek.
 * The directory itself and its descendants are two separate runs rather than
 * one `OR`: with the `OR` the planner falls back to scanning every live
 * location in the library on every page. `'0'` is the character after `'/'`,
 * so `[rel/, rel0)` is exactly the paths under `rel/` — a sibling such as
 * `rel-2024` sorts between `rel` and `rel/` and is in neither run.
 */
type PathRun = { equals: string } | { from: string; before: string | null };

export function subtreeRuns(relDir: string): PathRun[] {
  if (relDir === '') return [{ from: '', before: null }];
  return [{ equals: relDir }, { from: `${relDir}/`, before: `${relDir}0` }];
}

function runPredicate(run: PathRun): { sql: string; params: string[] } {
  if ('equals' in run) return { sql: 'l.path = ?', params: [run.equals] };
  if (run.before === null) return { sql: 'l.path >= ?', params: [run.from] };
  return { sql: 'l.path >= ? AND l.path < ?', params: [run.from, run.before] };
}

/**
 * One page of live locations of non-trashed assets in `run`, in index order
 * after the `(path, filename)` cursor. Trashed assets are left alone: their
 * locations already point into `.maple/trash/`, which belongs to the trash
 * retention window.
 */
export async function listLiveLocationsIn(
  libraryId: ObjectId,
  run: PathRun,
  after: IgnoredLiveLocation | null,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<IgnoredLiveLocation[]> {
  const range = runPredicate(run);
  const cursor = after
    ? { sql: 'AND (l.path, l.filename) > (?, ?)', params: [after.path, after.filename] }
    : { sql: '', params: [] };
  return sqliteDb(dbOverride).read<IgnoredLiveLocation>(
    `SELECT l.path, l.filename
       FROM asset_locations l INDEXED BY asset_locations_lib_path_name
       JOIN assets a ON a.id = l.asset_id
      WHERE l.library_id = ? AND ${range.sql} ${cursor.sql}
        AND l.deleted_at IS NULL AND l.missing_since IS NULL
        AND a.deleted_at IS NULL
      ORDER BY l.path, l.filename
      LIMIT ?`,
    [toHex(libraryId), ...range.params, ...cursor.params, limit],
  );
}
