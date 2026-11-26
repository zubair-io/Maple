/**
 * Where an import looks for a movie the library may already hold (#5635).
 *
 * The catalog only nominates candidates, by `sha1_head`: an identical file has
 * an identical head, but two different clips can share one, so the caller
 * confirms a candidate against the file on disk. A candidate is a live,
 * not-missing location, in the library being imported into, of an asset that is
 * not in the trash.
 *
 * Both indexes are named so the planner drives from the asset side (a search of
 * `assets` by head, then its live locations) and never scans every location of
 * the library once per imported movie.
 */

import type { ObjectId } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toHex } from './values.ts';

export interface CandidateLocation {
  path: string;
  filename: string;
}

const CANDIDATE_LOCATIONS_SQL = `
  SELECT l.path AS path, l.filename AS filename
    FROM assets a INDEXED BY assets_sha1_head
    JOIN asset_locations l INDEXED BY asset_locations_live_by_asset ON l.asset_id = a.id
   WHERE a.sha1_head = ? AND a.sha1_head IS NOT NULL AND a.deleted_at IS NULL
     AND l.library_id = ? AND l.deleted_at IS NULL AND l.missing_since IS NULL
   ORDER BY l.path, l.filename
   LIMIT ?`;

export function candidateLocationsForHead(
  sha1_head: string,
  libraryId: ObjectId,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<CandidateLocation[]> {
  return sqliteDb(dbOverride).read<CandidateLocation>(CANDIDATE_LOCATIONS_SQL, [
    sha1_head,
    toHex(libraryId),
    limit,
  ]);
}
