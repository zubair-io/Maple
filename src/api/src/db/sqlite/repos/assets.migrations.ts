/**
 * The candidate sweeps behind the operator-visible data migrations — the
 * SQLite port of the `{ $ne: VERSION }` selectors every module under
 * `workers/migration/` used to build by hand (#3787).
 *
 * These are the migrations that appear on Settings → Workers and run against
 * the library, not the MongoDB-to-SQLite boot migration, which reads MongoDB on
 * purpose and is untouched by this work.
 *
 * ## Every one of them has the same shape
 *
 * Count the assets that match a predicate and are not yet stamped at the
 * current generation; take a page of their ids; do something; stamp them. The
 * stamp is the done-marker that makes `countRemaining` converge to zero, and it
 * is what stops a migration re-selecting the same unresolvable row forever —
 * the head-of-line blocking #1519 is named after.
 *
 * So the three verbs are shared and the predicate is the only thing each
 * migration supplies. The marker column is a closed union rather than a string,
 * because it is interpolated into the statement: the names are declared in
 * `ddl/assets.ts` and a caller cannot invent one.
 *
 * ## The predicates that appear more than once, spelled once
 *
 * Liveness, backup origin and "is a video whose video file is live" are each
 * used by several migrations, and on Mongo each was re-spelled per module. The
 * video one in particular is a correctness rule, not a convenience:
 * `media_kind = 'video'` says a video location exists, not that it is *live*,
 * so a Live Photo backup whose `.mov` was soft-deleted (its `.heic` still live)
 * must not be a candidate. A migration that matched it would queue reads of a
 * missing file that can only fail.
 */

import type { ObjectId } from 'mongodb';
import { VIDEO_EXTS } from '../../../indexer/media-types.ts';
import type { AssetExif, FileInfo, Place } from '../../schema.ts';
import { stageRearmBatchStatement } from './assets.stage-rearm.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { placeholders, toBool, toHex, toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/**
 * The one-shot generation markers declared on `assets`.
 *
 * Each is `NULL` until its migration stamps it, and `{ $ne: N }` — here
 * `IS NOT N`, which is SQLite's null-safe inequality and therefore matches an
 * unstamped row as well as a row stamped at an older generation.
 */
export type MigrationMarker =
  | 'backup_layout_version'
  | 'legacy_daydir_version'
  | 'video_meta_version'
  | 'video_poster_rearm_version'
  | 'video_screenshot_clear_version'
  | 'preview_missing_redrive_version';

/** A location whose file is still where the asset says it is. */
export const LIVE_LOCATION = `l.deleted_at IS NULL AND l.missing_since IS NULL`;

/** The asset holds at least one live location. */
export const HAS_LIVE_LOCATION = `EXISTS (
  SELECT 1 FROM asset_locations l WHERE l.asset_id = a.id AND ${LIVE_LOCATION})`;

/** The asset came from a mobile backup, i.e. it carries at least one PHAsset link. */
export const BACKUP_ORIGIN = `EXISTS (
  SELECT 1 FROM asset_phasset_links p WHERE p.asset_id = a.id)`;

/** `filename LIKE '%.mov' OR …` over a set of extensions. LIKE is
 * case-insensitive for ASCII in SQLite, which is the `/i` the regexes carried. */
function filenameMatches(extensions: readonly string[], negate = false): string {
  const op = negate ? 'NOT LIKE' : 'LIKE';
  const joiner = negate ? ' AND ' : ' OR ';
  return `(${extensions.map((ext) => `l.filename ${op} '%${ext}'`).join(joiner)})`;
}

const ANY_VIDEO_FILENAME = filenameMatches([...VIDEO_EXTS]);

/** The two containers the geo-backfill pair was written for. */
const GEO_VIDEO_EXTS = ['.mp4', '.mov'] as const;

/**
 * "Is a video AND that video location is live."
 *
 * `media_kind` is the cheap half — an equality the `assets_media_kind_av`
 * partial index serves — and the filename test on the same row is what keeps it
 * honest, for the reason in the module comment.
 */
export const LIVE_VIDEO = `a.media_kind = 'video' AND EXISTS (
  SELECT 1 FROM asset_locations l
   WHERE l.asset_id = a.id AND ${LIVE_LOCATION} AND ${ANY_VIDEO_FILENAME})`;

/** The geo-backfill pair's narrower scope: a live `.mp4`/`.mov` location. */
export const LIVE_GEO_VIDEO = `a.media_kind = 'video' AND EXISTS (
  SELECT 1 FROM asset_locations l
   WHERE l.asset_id = a.id AND ${LIVE_LOCATION}
     AND ${filenameMatches(GEO_VIDEO_EXTS)})`;

/** A donor must be a photo, not another video. */
export const LIVE_PHOTO_IN_LIBRARY = `EXISTS (
  SELECT 1 FROM asset_locations l
   WHERE l.asset_id = a.id AND l.library_id = ? AND ${LIVE_LOCATION}
     AND ${filenameMatches(GEO_VIDEO_EXTS, true)})`;

/** What a sweep selects on: a predicate over `assets a`, plus its bound values. */
export interface CandidateScope {
  sql: string;
  params?: readonly (string | number)[];
}

/**
 * Narrow a scope to the assets this generation has not stamped yet.
 *
 * `IS NOT` rather than `<>` because it is SQLite's null-safe inequality, and an
 * unstamped row holds NULL: `<>` would answer NULL for it and the row would
 * never be selected, which is every row on the first run.
 */
export function unstamped(
  scope: CandidateScope,
  marker: MigrationMarker,
  version: number,
): CandidateScope {
  return { sql: `${scope.sql} AND a.${marker} IS NOT ${version}`, params: scope.params };
}

/** How many assets still need this migration. */
export async function countCandidates(
  scope: CandidateScope,
  dbOverride?: SqliteDb,
): Promise<number> {
  const rows = await sqliteDb(dbOverride).read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM assets a WHERE ${scope.sql}`,
    [...(scope.params ?? [])],
  );
  return rows[0]?.n ?? 0;
}

/** At most `limit` of their ids. Unordered, like the `find().limit()` it replaces. */
export async function listCandidateIds(
  scope: CandidateScope,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<ObjectId[]> {
  const rows = await sqliteDb(dbOverride).read<{ id: string }>(
    `SELECT a.id FROM assets a WHERE ${scope.sql} LIMIT ?`,
    [...(scope.params ?? []), limit],
  );
  return rows.map((row) => toObjectId(row.id));
}

/**
 * Stamp the done-marker on a set of assets.
 *
 * Unconditional on the candidate predicate, because every caller has already
 * decided this asset is handled — including the callers whose decision was
 * "there is nothing I can do with this one", which is exactly the case the
 * marker exists for.
 */
export async function stampMarker(
  marker: MigrationMarker,
  version: number,
  ids: readonly ObjectId[],
  dbOverride?: SqliteDb,
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await sqliteDb(dbOverride).write(
    `UPDATE assets SET ${marker} = ? WHERE id IN (${placeholders(ids.length)})`,
    [version, ...ids.map(toHex)],
  );
  return result.changes;
}

/**
 * Re-queue a set of stages for a batch of assets and stamp the done-marker, in
 * one transaction.
 *
 * This is the whole of the three migrations that move nothing on disk —
 * `rearm-video-posters`, `clear-video-screenshot-flags`'s stage half, and
 * `redrive-preview-missing-describe`. The actual work happens later, on the
 * stage workers' own schedule and under their own concurrency limits, once
 * these rows become claimable again.
 *
 * Both writes in one transaction is the part that is better than what it
 * replaces. On Mongo the stamp and the re-arm were separate `updateMany` calls
 * and the ordering between them had to be reasoned about per migration, because
 * a failure in the gap could leave a row stamped done with its stages never
 * re-armed — stranded, and silently so. Here either both land or neither does,
 * and a failed batch is simply retried.
 *
 * `guard` re-asserts the candidate predicate at write time for the migration
 * whose candidates a worker can legitimately resolve underneath it. A row that
 * raced away is not modified, and not counted.
 */
export async function rearmStagesAndStamp(
  ids: readonly ObjectId[],
  stages: readonly string[],
  marker: MigrationMarker,
  version: number,
  guard?: CandidateScope,
  dbOverride?: SqliteDb,
): Promise<number> {
  if (ids.length === 0) return 0;
  const hexes = ids.map(toHex);
  const also = guard === undefined ? '' : ` AND (${guard.sql})`;
  const guardParams = [...(guard?.params ?? [])];
  const results = await sqliteDb(dbOverride).transaction([
    {
      sql: `UPDATE assets AS a SET ${marker} = ?
             WHERE a.id IN (${placeholders(hexes.length)})${also}`,
      params: [version, ...hexes, ...guardParams],
    },
    ...stages.map((stage) =>
      stageRearmBatchStatement(hexes, stage, guard && { sql: guard.sql, params: guardParams }),
    ),
  ]);
  return results[0]?.changes ?? 0;
}

/**
 * Assets whose stored `live_location_count` disagrees with their locations.
 *
 * The column is derived by the triggers in `ddl/asset-locations.ts`, so this
 * should always be zero and the migration that consumes it is a drift check
 * rather than the backfill it used to be — there is no "field not written yet"
 * state for a `NOT NULL DEFAULT 0` column that three triggers maintain. It is
 * kept, and kept on Settings → Workers, because the count is load-bearing for
 * every facet and browse query (it is what makes the live predicate an indexable
 * column rather than a sub-select), so an operator who doubts it should have a
 * way to check and repair without shell access.
 */
const DRIFTED = `a.live_location_count <> (
  SELECT COUNT(*) FROM asset_locations l
   WHERE l.asset_id = a.id AND l.deleted_at IS NULL AND l.missing_since IS NULL)`;

export async function countLiveLocationCountDrift(dbOverride?: SqliteDb): Promise<number> {
  const rows = await sqliteDb(dbOverride).read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM assets a WHERE ${DRIFTED}`,
  );
  return rows[0]?.n ?? 0;
}

/** Recompute the count for at most `limit` drifted assets. Returns how many. */
export async function repairLiveLocationCounts(
  limit: number,
  dbOverride?: SqliteDb,
): Promise<number> {
  const result = await sqliteDb(dbOverride).write(
    `UPDATE assets SET live_location_count = (
       SELECT COUNT(*) FROM asset_locations l
        WHERE l.asset_id = assets.id AND l.deleted_at IS NULL AND l.missing_since IS NULL)
      WHERE id IN (SELECT a.id FROM assets a WHERE ${DRIFTED} LIMIT ?)`,
    [limit],
  );
  return result.changes;
}

/**
 * The fields the file-moving migrations read off a candidate.
 *
 * `locations` is every location in array order, tags included, not just the
 * live ones: `assetPrimaryFileInfo` picks the first live entry out of it and
 * `moveBackupAsset` picks the first non-deleted one, and the difference between
 * those two is load-bearing (#1519) — a delete-then-readd asset carries a
 * tombstone ahead of its live entry, and collapsing the list here would hide
 * which is which.
 */
export interface MigrationCandidate {
  id: ObjectId;
  maple_id: string | undefined;
  apple_rendered_path: string | null;
  place: Place | null;
  is_screenshot: boolean;
  exif: Pick<AssetExif, 'captured_at' | 'captured_year' | 'captured_month'> | null;
  fileinfo: FileInfo[];
}

/** The projection every candidate read selects, spelled once. */
export const CANDIDATE_COLUMNS = `a.id, a.maple_id, a.apple_rendered_path, a.place,
  a.is_screenshot, a.captured_at, a.captured_year, a.captured_month`;

export interface CandidateRow {
  id: string;
  maple_id: string | null;
  apple_rendered_path: string | null;
  place: string | null;
  is_screenshot: number | null;
  captured_at: string | null;
  captured_year: number | null;
  captured_month: number | null;
}

interface LocationRow {
  asset_id: string;
  library_id: string;
  path: string;
  filename: string;
  deleted_at: string | null;
  missing_since: string | null;
  missing_reason: string | null;
  keep: number;
}

/** Every location of every asset in the batch, grouped and in array order. */
export async function loadCandidateLocations(
  db: SqliteDb,
  ids: readonly string[],
): Promise<Map<string, FileInfo[]>> {
  const grouped = new Map<string, FileInfo[]>();
  if (ids.length === 0) return grouped;
  const rows = await db.read<LocationRow>(
    `SELECT asset_id, library_id, path, filename, deleted_at, missing_since, missing_reason, keep
       FROM asset_locations WHERE asset_id IN (${placeholders(ids.length)})
      ORDER BY asset_id, ordinal`,
    [...ids],
  );
  for (const row of rows) {
    const list = grouped.get(row.asset_id) ?? [];
    list.push({
      library_id: toObjectId(row.library_id),
      path: row.path,
      filename: row.filename,
      deleted_at: row.deleted_at,
      missing_since: row.missing_since,
      missing_reason: row.missing_reason,
      keep: toBool(row.keep),
    });
    grouped.set(row.asset_id, list);
  }
  return grouped;
}

/**
 * A page of candidates with everything the file-moving migrations need to
 * compute a destination: two queries, not one per asset.
 *
 * The projection is narrow on purpose. `place` is the only JSON column read,
 * and the capture year and month come from the generated columns rather than
 * from a second parse of `exif` — which is the difference between this and the
 * Mongo `find` it replaces, where the whole document came back and the dotted
 * `'exif.captured_year': 1` projection still materialised the subdocument.
 */
export async function listCandidates(
  scope: CandidateScope,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<MigrationCandidate[]> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS} FROM assets a WHERE ${scope.sql} LIMIT ?`,
    [...(scope.params ?? []), limit],
  );
  if (rows.length === 0) return [];
  const locations = await loadCandidateLocations(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toCandidate(row, locations.get(row.id) ?? []));
}

/** A candidate row and its locations as the migrations read them. */
export function toCandidate(row: CandidateRow, fileinfo: FileInfo[]): MigrationCandidate {
  const dated =
    row.captured_at !== null || row.captured_year !== null || row.captured_month !== null;
  return {
    id: toObjectId(row.id),
    maple_id: row.maple_id ?? undefined,
    apple_rendered_path: row.apple_rendered_path,
    place: row.place === null ? null : (JSON.parse(row.place) as Place),
    is_screenshot: row.is_screenshot === 1,
    exif: dated
      ? {
          captured_at: row.captured_at,
          captured_year: row.captured_year,
          captured_month: row.captured_month,
        }
      : null,
    fileinfo,
  };
}
