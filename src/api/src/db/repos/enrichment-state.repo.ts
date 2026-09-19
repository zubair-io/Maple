/**
 * `enrichment_state` — the dead-letter triage half of the slow-tier enrichment
 * bookkeeping (#3787).
 *
 * ## What this replaces
 *
 * `enrichment/dead-letter.repo.ts`'s three operations against the asset
 * document: the `find` that lists rows stamped with
 * `enrichment.<stage>.dead_letter_at`, the aggregation that clusters them by
 * error message, and the `updateMany` that clears the stamp so the next worker
 * tick re-claims the row. The stage's per-asset state is its own table here
 * (see `../ddl/stage-state.ts`), so all three are ordinary statements against
 * two columns rather than dotted paths into a subdocument.
 *
 * ## The list is an index range scan, where Mongo scanned the collection
 *
 * `{ 'enrichment.geocode.dead_letter_at': { $ne: null } }` sorted descending has
 * no index behind it on Mongo, so the triage page reads every asset document to
 * answer a question about the handful that are parked. The
 * `enrichment_dead_letter` partial index holds only the parked rows, already in
 * the order the page wants, so the same page reads what it displays.
 *
 * ## Why the reset keeps its dead-letter filter even for one asset
 *
 * Clearing `attempts` on a row that is *not* dead-lettered would wipe the retry
 * state of an asset a worker is processing right now. The Mongo version guarded
 * against that by always including the dead-letter predicate alongside the id,
 * and so does this one — an id that names a live row matches nothing and reports
 * zero, which is what the route surfaces as "nothing to reset".
 *
 * The id itself needs no validation here. On Mongo a malformed hex string threw
 * inside `new ObjectId(...)` and had to be caught to mean "matches nothing";
 * against a TEXT column it simply matches nothing.
 */

import * as path from 'node:path';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { loadLibraries, loadLocations } from './assets.read.ts';
import type { LocationRow } from './assets.rows.ts';

export type { SqliteDb } from './db-handle.ts';

/** One parked row as the triage list renders it. */
export interface DeadLetterRow {
  asset_id: string;
  /** `null` when no location is still live, or its library is unregistered. */
  abs_path: string | null;
  last_error: string | null;
  attempts: number;
  dead_letter_at: string;
}

/** One bucket of {@link groupDeadLettered}: an error prefix and its tally. */
export interface DeadLetterGroup {
  errorClass: string;
  count: number;
  latestTs: string;
}

const LIST_SQL = `
  SELECT asset_id, last_error, attempts, dead_letter_at
    FROM enrichment_state
   WHERE stage = ? AND dead_letter_at IS NOT NULL
   ORDER BY dead_letter_at DESC
   LIMIT ?`;

/**
 * `substr` counts characters rather than bytes, which is what makes it the
 * equivalent of the `$substrCP` the aggregation used: a multi-byte error
 * message truncates at the same place under both engines instead of splitting a
 * character in half.
 */
const GROUP_SQL = `
  SELECT substr(COALESCE(last_error, ''), 1, ?) AS errorClass,
         COUNT(*) AS count,
         MAX(dead_letter_at) AS latestTs
    FROM enrichment_state
   WHERE stage = ? AND dead_letter_at IS NOT NULL
   GROUP BY errorClass
   ORDER BY count DESC, latestTs DESC`;

const RESET_SQL = `
  UPDATE enrichment_state
     SET dead_letter_at = NULL, last_error = NULL, attempts = 0
   WHERE stage = ? AND dead_letter_at IS NOT NULL`;

interface StateRow {
  asset_id: string;
  last_error: string | null;
  attempts: number;
  dead_letter_at: string;
}

/**
 * The absolute path of an asset's primary live location.
 *
 * Primary is the first location that is neither replaced in place nor gone from
 * disk, and a row with none resolves to `null` rather than to a path that names
 * nothing — the triage UI shows the entry regardless so an operator can still
 * clear it. A location whose library is no longer registered resolves to `null`
 * for the same reason.
 */
function absPathOf(
  rows: readonly LocationRow[],
  libraries: ReadonlyMap<string, string>,
): string | null {
  const primary = rows.find((row) => row.deleted_at === null && row.missing_since === null);
  if (primary === undefined) return null;
  const root = libraries.get(primary.library_id);
  if (root === undefined) return null;
  const segments = primary.path === '' ? [] : primary.path.split('/');
  return path.join(root, ...segments, primary.filename);
}

/** Parked rows for one stage, newest dead-letter first. */
export async function listDeadLettered(
  stage: string,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<DeadLetterRow[]> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<StateRow>(LIST_SQL, [stage, limit]);
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.asset_id);
  const [libraries, locations] = await Promise.all([loadLibraries(db), loadLocations(db, ids)]);
  return rows.map((row) => ({
    asset_id: row.asset_id,
    abs_path: absPathOf(locations.get(row.asset_id) ?? [], libraries),
    last_error: row.last_error,
    attempts: row.attempts,
    dead_letter_at: row.dead_letter_at,
  }));
}

/** Parked rows clustered by the first `errorClassLength` characters of their error. */
export async function groupDeadLettered(
  stage: string,
  errorClassLength: number,
  dbOverride?: SqliteDb,
): Promise<DeadLetterGroup[]> {
  return sqliteDb(dbOverride).read<DeadLetterGroup>(GROUP_SQL, [errorClassLength, stage]);
}

/**
 * Clear the dead-letter stamp and its retry counters, so the next tick
 * re-claims the row. Returns how many rows were cleared.
 *
 * With `assetId` it targets that one asset; without, every parked row for the
 * stage. Other stages on the same asset are untouched, because they are
 * different rows.
 */
export async function clearDeadLetter(
  stage: string,
  assetId: string | undefined,
  dbOverride?: SqliteDb,
): Promise<number> {
  const sql = assetId === undefined ? RESET_SQL : `${RESET_SQL} AND asset_id = ?`;
  const params = assetId === undefined ? [stage] : [stage, assetId];
  const result = await sqliteDb(dbOverride).write(sql, params);
  return result.changes;
}
