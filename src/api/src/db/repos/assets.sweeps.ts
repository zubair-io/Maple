/**
 * The candidate sets and the writes the library-wide sweeper workers run on
 * (#3787).
 *
 * Six workers share this module — trash-gc, the missing-reaper, deduplicate,
 * cache-gc, mirror-scan and the derivative audit. They have nothing in common
 * at the filesystem layer and everything in common at the database layer: each
 * one pages through a narrow candidate set on an interval and then writes back
 * per asset. Putting those queries in one place is what keeps each of them
 * reaching an index instead of scanning `assets` on every tick.
 *
 * ## The index behind each candidate query
 *
 * | worker             | predicate                                | index                          |
 * | ------------------ | ---------------------------------------- | ------------------------------ |
 * | trash-gc           | `deleted_at IS NOT NULL AND < cutoff`    | `assets_trashed`               |
 * | missing-reaper     | `missing_since IS NOT NULL`              | `asset_locations_missing`      |
 * | deduplicate        | `live_location_count >= 2`               | `asset_locations_live_by_asset` |
 * | cache-gc           | one library's live entries               | `asset_locations_library_live` |
 * | mirror-scan        | every live entry, keyset-paged           | `asset_locations` primary key  |
 * | derivative-audit   | live, undamaged, keyset-paged            | `assets_live_id`               |
 *
 * Two of those replace a MongoDB partial index the query had to be written a
 * particular way to reach. `deleted_at_1` was filtered to `$type: "string"`, so
 * the trash sweep had to say `$type` or take a collection scan;
 * `fileinfo_missing_since_1` was the same story for the reaper. SQLite's
 * implication test is textual rather than value-based, so the equivalent
 * discipline is that a query's `WHERE` repeats the index's predicate verbatim —
 * `deleted_at IS NOT NULL`, `missing_since IS NOT NULL` — which is what the
 * statements below do. `schema.indexes.test.ts` pins the index set.
 *
 * ## Why the writes are per asset
 *
 * After boot the API process and the worker child both hold SQLite writer
 * connections, arbitrated by the file lock with a five-second busy timeout.
 * That only holds while no transaction is long, so every write here is scoped
 * to one asset and a sweep is a loop over them — never one transaction around
 * the pass. `live_location_count` is maintained by triggers on
 * `asset_locations`, so scoping to one asset still leaves the roll-up and the
 * rows it counts committing together.
 */

import type { ObjectId } from '../object-id.ts';
import type { FileInfo } from '../schema.ts';
import { toFileInfo, type LocationRow } from './assets.rows.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { parseJson, placeholders, toObjectId } from './values.ts';

/** One location as the sweepers address it — the `fileinfo[]` entry's identity. */
export interface LocationAddress {
  libraryId: string;
  path: string;
  filename: string;
}

/** A trashed asset the retention sweep may purge. */
export interface TrashedAsset {
  _id: ObjectId;
  deleted_reason: string | null;
  fileinfo: FileInfo[];
}

/** An asset holding at least one location tagged `missing_since`. */
export interface MissingTaggedAsset {
  _id: ObjectId;
  maple_id: string | null;
  fileinfo: FileInfo[];
  /** Original-file stages currently dead-lettered, for the recovery re-arm. */
  deadStages: string[];
}

/** An asset with two or more live locations — one duplicate set. */
export interface DuplicateCandidate {
  _id: ObjectId;
  maple_id: string | null;
  fileinfo: FileInfo[];
}

/** A live location together with the asset that owns it. */
export interface LiveLocationRow {
  id: number;
  asset_id: string;
  library_id: string;
  path: string;
  filename: string;
}

/** Per-year asset counts for one library — the generated-search digest. */
export interface YearCount {
  year: number;
  count: number;
}

const LOCATION_COLUMNS = `asset_id, ordinal, library_id, path, filename,
                          deleted_at, missing_since, missing_reason, keep`;

/** Locations for a page of assets, grouped by asset and in array order. */
async function locationsFor(
  db: SqliteDb,
  assetIds: readonly string[],
): Promise<Map<string, LocationRow[]>> {
  if (assetIds.length === 0) return new Map();
  const rows = await db.read<LocationRow>(
    `SELECT ${LOCATION_COLUMNS} FROM asset_locations
      WHERE asset_id IN (${placeholders(assetIds.length)})
      ORDER BY asset_id, ordinal`,
    [...assetIds],
  );
  const byAsset = new Map<string, LocationRow[]>();
  for (const row of rows) {
    const existing = byAsset.get(row.asset_id);
    if (existing) existing.push(row);
    else byAsset.set(row.asset_id, [row]);
  }
  return byAsset;
}

/**
 * A page of candidate rows as the sweeper's own shape, with each asset's
 * `fileinfo[]` attached.
 *
 * Every candidate query here is the same two steps: one statement decides which
 * assets are in the page, and a second fetches the locations for exactly those
 * ids. Keeping the second step in one place is what stops a sweep from drifting
 * into a lookup per asset, which on a trash backlog is one round trip per row
 * on the pool's readers every time the timer fires. What each sweeper does with
 * the result differs — the purge reads the delete reason, the deduplicate
 * worker reads `maple_id` — so the shape stays the caller's to build.
 */
async function withFileinfo<Row extends { id: string }, Candidate>(
  db: SqliteDb,
  rows: readonly Row[],
  build: (row: Row, fileinfo: FileInfo[]) => Candidate,
): Promise<Candidate[]> {
  const locations = await locationsFor(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => build(row, toFileInfo(locations.get(row.id) ?? [])));
}

// ---------------------------------------------------------------------------
// Candidate sets
// ---------------------------------------------------------------------------

/**
 * Trashed assets whose `deleted_at` predates the retention cutoff.
 *
 * `deleted_at IS NOT NULL` is spelled out beside the range test for the reason
 * the Mongo query spelled out `$type: "string"`: without it the predicate does
 * not provably imply `assets_trashed`'s own, and the sweep becomes a scan of
 * every asset in the library on a daily timer.
 */
export async function listTrashedBefore(
  cutoffIso: string,
  dbOverride?: SqliteDb,
): Promise<TrashedAsset[]> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<{ id: string; deleted_reason: string | null }>(
    `SELECT id, deleted_reason FROM assets
      WHERE deleted_at IS NOT NULL AND deleted_at < ?
      ORDER BY deleted_at`,
    [cutoffIso],
  );
  return withFileinfo(db, rows, (row, fileinfo) => ({
    _id: toObjectId(row.id),
    deleted_reason: row.deleted_reason,
    fileinfo,
  }));
}

/** The original-file stages whose dead-letter a recovery clears. */
const ORIGINAL_FILE_STAGES = ['exif', 'thumb', 'preview'] as const;

/**
 * Assets holding at least one location tagged `missing_since` and not already
 * soft-deleted, oldest tag first.
 *
 * Oldest-first is what lets a backlog drain in order, and paging past it is
 * what stops recovery starving behind rows the pass cannot resolve — a row
 * still in cooldown, or under an offline mount, stays tagged and would
 * otherwise be re-fetched at the head of every page forever (#2171). The
 * ordering key is each asset's *earliest* tagged entry, which is what the Mongo
 * multikey sort gave.
 *
 * A row already in the trash is out of scope: a user-trashed row belongs to the
 * trash retention window and a previously reaped one is done.
 */
export async function listMissingTagged(
  options: { limit: number; offset?: number },
  dbOverride?: SqliteDb,
): Promise<MissingTaggedAsset[]> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<{ id: string; maple_id: string | null }>(
    `SELECT a.id AS id, a.maple_id AS maple_id
       FROM asset_locations l
       JOIN assets a ON a.id = l.asset_id
      WHERE l.missing_since IS NOT NULL AND a.deleted_at IS NULL
      GROUP BY a.id
      ORDER BY MIN(l.missing_since)
      LIMIT ? OFFSET ?`,
    [options.limit, options.offset ?? 0],
  );
  const ids = rows.map((row) => row.id);
  const [locations, dead] = await Promise.all([
    locationsFor(db, ids),
    deadOriginalFileStages(db, ids),
  ]);
  return rows.map((row) => ({
    _id: toObjectId(row.id),
    maple_id: row.maple_id,
    fileinfo: toFileInfo(locations.get(row.id) ?? []),
    deadStages: dead.get(row.id) ?? [],
  }));
}

/** Which of the original-file stages are dead-lettered, per asset. */
async function deadOriginalFileStages(
  db: SqliteDb,
  assetIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (assetIds.length === 0) return new Map();
  const rows = await db.read<{ asset_id: string; stage: string }>(
    `SELECT asset_id, stage FROM stage_state
      WHERE asset_id IN (${placeholders(assetIds.length)})
        AND stage IN (${placeholders(ORIGINAL_FILE_STAGES.length)})
        AND dead = 1`,
    [...assetIds, ...ORIGINAL_FILE_STAGES],
  );
  const byAsset = new Map<string, string[]>();
  for (const row of rows) {
    const existing = byAsset.get(row.asset_id);
    if (existing) existing.push(row.stage);
    else byAsset.set(row.asset_id, [row.stage]);
  }
  return byAsset;
}

/**
 * Assets with two or more live locations — the deduplicate worker's backlog.
 *
 * `live_location_count` is maintained by the `asset_locations` triggers, so
 * "two or more live entries" is a column test rather than the Mongo version's
 * partial index on `fileinfo.1` followed by an `$expr`/`$filter` pass counting
 * the non-tombstoned entries of every candidate row in memory. It is the same
 * predicate the Workers badge counts on, so the badge still reaches zero from
 * this worker alone.
 */
export async function listDuplicateCandidates(
  limit: number,
  dbOverride?: SqliteDb,
): Promise<DuplicateCandidate[]> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<{ id: string; maple_id: string | null }>(
    `SELECT id, maple_id FROM assets
      WHERE live_location_count >= 2 AND deleted_at IS NULL
      LIMIT ?`,
    [limit],
  );
  return withFileinfo(db, rows, (row, fileinfo) => ({
    _id: toObjectId(row.id),
    maple_id: row.maple_id,
    fileinfo,
  }));
}

/**
 * Live entries of one library as `directory → filenames`.
 *
 * The cache-gc sweep asks, per directory, whether some live file there is named
 * X — both the thumbs and the previews tiers are path-keyed. One statement over
 * `asset_locations_library_live` answers it for the whole library; the Mongo
 * version had to stream every matching asset *document* and re-filter its array
 * in TypeScript, because `$elemMatch` returns documents and cannot project the
 * entries that matched.
 */
export async function liveLocationsByDirectory(
  libraryId: string,
  dbOverride?: SqliteDb,
): Promise<Map<string, Set<string>>> {
  const rows = await sqliteDb(dbOverride).read<{ path: string; filename: string }>(
    `SELECT path, filename FROM asset_locations
      WHERE library_id = ? AND deleted_at IS NULL AND missing_since IS NULL`,
    [libraryId],
  );
  const byDirectory = new Map<string, Set<string>>();
  for (const row of rows) {
    const names = byDirectory.get(row.path) ?? new Set<string>();
    names.add(row.filename);
    byDirectory.set(row.path, names);
  }
  return byDirectory;
}

/**
 * One keyset page of live locations across every library.
 *
 * Keyset rather than `LIMIT`/`OFFSET` because the mirror scan walks the whole
 * table and an offset page re-reads every row before it, so the last page costs
 * the table. `id` is an `INTEGER PRIMARY KEY`, which makes `id > ?` a seek to
 * the resume point however far in the caller is. Paged at all — rather than read
 * whole — because the Mongo version was a cursor, and a library with hundreds of
 * thousands of files must not materialise every location to check it against a
 * mirror.
 */
export async function listLiveLocationsAfter(
  afterId: number,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<LiveLocationRow[]> {
  return sqliteDb(dbOverride).read<LiveLocationRow>(
    `SELECT id, asset_id, library_id, path, filename
       FROM asset_locations
      WHERE id > ? AND deleted_at IS NULL AND missing_since IS NULL
      ORDER BY id
      LIMIT ?`,
    [afterId, limit],
  );
}

/**
 * Per-year counts of assets located in one library, optionally narrowed to one
 * capture month — the two histograms the generated-search prompt digest is
 * built from.
 *
 * Neither liveness nor the hidden flag is filtered, matching the Mongo
 * aggregation this replaces: the digest is a statement about what the library
 * holds, and the collections it produces are re-executed through the search
 * filter at read time anyway.
 */
export async function capturedYearCounts(
  libraryId: string,
  month: number | null,
  dbOverride?: SqliteDb,
): Promise<YearCount[]> {
  const monthClause = month === null ? '' : 'AND a.captured_month = ?';
  const monthParams = month === null ? [] : [month];
  return sqliteDb(dbOverride).read<YearCount>(
    `SELECT a.captured_year AS year, COUNT(*) AS count
       FROM assets a
      WHERE a.captured_year IS NOT NULL ${monthClause}
        AND EXISTS (SELECT 1 FROM asset_locations l
                     WHERE l.asset_id = a.id AND l.library_id = ?)
      GROUP BY a.captured_year
      ORDER BY a.captured_year`,
    [...monthParams, libraryId],
  );
}

/** Per-stage derivative-audit cooldown mark. */
export interface AuditMark {
  attempts: number;
  last_reset_at: string;
}

/** One asset's stored audit marks, or null when it has never been audited. */
function parseAuditMarks(text: string | null): Record<string, AuditMark | undefined> | null {
  return parseJson<Record<string, AuditMark | undefined> | null>(text, null);
}

/** One asset as the derivative audit evaluates it. */
export interface AuditCandidate {
  rowId: string;
  _id: ObjectId;
  maple_id: string | null;
  hidden: boolean;
  fileinfo: FileInfo[];
  description: string | null;
  stages: Record<string, { version: number }>;
  derivative_audit: Record<string, AuditMark | undefined> | null;
}

/**
 * One keyset page of live, undamaged assets for the derivative audit.
 *
 * Keyset on the text primary key rather than an offset, for the reason the
 * mirror scan uses one: the audit walks the whole live set and an offset page
 * re-reads everything before it. `assets_live_id` is a partial index keyed on
 * `id` over exactly this predicate, so the page is an index range scan that
 * never reads a row to test liveness.
 *
 * The audit's verdict needs the asset's stage versions, its caption and its
 * cooldown marks, so those come back with it — three statements per page rather
 * than one per asset.
 *
 * One deliberate narrowing against the Mongo query this replaces: that one
 * tested only the per-entry liveness (`fileinfo.$elemMatch`), so a trashed asset
 * still holding a live entry was audited. `deleted_at IS NULL` is half of
 * `LIVE_ASSET_PREDICATE` and therefore required for `assets_live_id` to be
 * usable at all — and re-arming a derivative stage for a file that is sitting in
 * `.maple/trash/` is work nobody wants. The trash workflow already re-arms
 * `thumb` and `preview` itself when it relocates the bytes.
 */
export async function listAuditCandidatesAfter(
  afterId: string,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<AuditCandidate[]> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<{ id: string; maple_id: string | null; hidden: number }>(
    `SELECT id, maple_id, hidden FROM assets
      WHERE deleted_at IS NULL AND live_location_count > 0
        AND damaged_since IS NULL AND id > ?
      ORDER BY id
      LIMIT ?`,
    [afterId, limit],
  );
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return [];
  const [locations, stages, detail] = await Promise.all([
    locationsFor(db, ids),
    db.read<{ asset_id: string; stage: string; version: number }>(
      `SELECT asset_id, stage, version FROM stage_state
        WHERE asset_id IN (${placeholders(ids.length)})`,
      [...ids],
    ),
    db.read<{ asset_id: string; description: string | null; derivative_audit: string | null }>(
      `SELECT asset_id, description, derivative_audit FROM asset_detail
        WHERE asset_id IN (${placeholders(ids.length)})`,
      [...ids],
    ),
  ]);

  const stagesByAsset = new Map<string, Record<string, { version: number }>>();
  for (const row of stages) {
    const existing = stagesByAsset.get(row.asset_id) ?? {};
    existing[row.stage] = { version: row.version };
    stagesByAsset.set(row.asset_id, existing);
  }
  const detailByAsset = new Map(detail.map((row) => [row.asset_id, row] as const));

  return rows.map((row) => ({
    rowId: row.id,
    _id: toObjectId(row.id),
    maple_id: row.maple_id,
    hidden: row.hidden === 1,
    fileinfo: toFileInfo(locations.get(row.id) ?? []),
    description: detailByAsset.get(row.id)?.description ?? null,
    stages: stagesByAsset.get(row.id) ?? {},
    derivative_audit: parseAuditMarks(detailByAsset.get(row.id)?.derivative_audit ?? null),
  }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * The sweepers' writes live in `./assets.sweeps.writes.ts` and are re-exported
 * here, so a worker imports its reads and its writes from one module. They are
 * a separate file because the two halves answer different questions — these
 * queries are a claim about which index runs them, and those writes are a claim
 * about what commits together.
 */
export {
  reapAsset,
  reconcileLocations,
  tagLocationsMissing,
  writeAuditMarks,
} from './assets.sweeps.writes.ts';
