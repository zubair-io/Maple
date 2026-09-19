/**
 * The `assets`-table statements the Meilisearch backfill and its vector-coverage
 * bookkeeping run (#3787).
 *
 * A module of its own rather than more statements in `assets.sql.ts`: that file
 * is the browse-and-detail repository's, and the two surfaces share no query.
 * What they do share is the table, so everything here still obeys its rules —
 * `LIVE_ASSET_PREDICATE` is imported from the DDL verbatim, because SQLite only
 * uses a partial index when the query's own `WHERE` provably implies the
 * index's and a paraphrase silently loses it.
 *
 * ## The cursor pass is a keyed range scan
 *
 * `find({ maple_id: { $type: 'string', $ne: '' } }).sort({ _id: 1 }).limit(n)`
 * becomes `WHERE maple_id IS NOT NULL AND id > ? ORDER BY id LIMIT ?`. The
 * emptiness half of the Mongo predicate is a CHECK on the column here, so it
 * needs no clause — and must not have one, since `assets_maple_id` is partial on
 * `maple_id IS NOT NULL` alone and an extra `<> ''` would stop the planner using
 * it (the same lesson `assets.sql.ts` records for the dedup probe).
 *
 * ## Why the batch is three statements rather than one join
 *
 * A row the backfill composes needs its locations and the person ids on its
 * faces, both of which are one-to-many. Joined into the asset query they would
 * multiply the rows and re-send every asset column once per location; issued
 * separately against the id set the first query already chose, they are two
 * index probes that never widen the batch — the same shape `assets.read.ts`
 * uses for the detail bundles.
 *
 * ## Faces carry columns nothing downstream reads, on purpose
 *
 * Only `person_id` matters to the search document: `loadNamedPeople` resolves
 * names from it and discards the rest. The bounding box and confidence come
 * along because `AssetFaceDoc` — the type that helper accepts — declares them
 * non-optional, and selecting the real columns is cheaper and more honest than
 * inventing placeholder geometry to satisfy a type. The embedding and landmark
 * payloads, which are the expensive part of a face row, are deliberately not
 * selected.
 */

import { LIVE_ASSET_PREDICATE } from '../sqlite/ddl/assets.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { placeholders } from './values.ts';
import type { LocationRow } from './assets.rows.ts';
import { groupByAsset } from './assets.rows.ts';
import { locationsByAssetIdsSql } from './assets.sql.ts';

export type { SqliteDb } from './db-handle.ts';

/**
 * Every column the search document is composed from.
 *
 * The SQLite counterpart of the shared `ROW_PROJECTION`: the two text payloads
 * and the vision object live in `asset_detail`, so the projection is a join
 * rather than a field list, but the set of values is the same one
 * `composeDocument` reads.
 */
const ASSET_COLUMNS = `
  a.id, a.maple_id, a.deleted_at, a.hidden, a.is_screenshot,
  a.captured_at, a.captured_month, a.place,
  d.description, d.ocr_text, d.transcript, d.vision`;

const ASSET_FROM = `FROM assets a LEFT JOIN asset_detail d ON d.asset_id = a.id`;

/** Indexable assets are the ones carrying a content-dedup id. */
const INDEXABLE = `a.maple_id IS NOT NULL`;

const ROWS_AFTER_SQL = `
  SELECT ${ASSET_COLUMNS} ${ASSET_FROM}
   WHERE ${INDEXABLE} AND a.id > ?
   ORDER BY a.id
   LIMIT ?`;

const ROWS_FROM_START_SQL = `
  SELECT ${ASSET_COLUMNS} ${ASSET_FROM}
   WHERE ${INDEXABLE}
   ORDER BY a.id
   LIMIT ?`;

const COUNT_AFTER_SQL = `SELECT COUNT(*) AS n FROM assets a WHERE ${INDEXABLE} AND a.id > ?`;
const COUNT_FROM_START_SQL = `SELECT COUNT(*) AS n FROM assets a WHERE ${INDEXABLE}`;

const EXISTS_AFTER_SQL = `SELECT a.id FROM assets a WHERE ${INDEXABLE} AND a.id > ? LIMIT 1`;

const FACES_SQL = (count: number): string => `
  SELECT asset_id, person_id, confidence, bbox_x, bbox_y, bbox_w, bbox_h
    FROM faces
   WHERE asset_id IN (${placeholders(count)})
   ORDER BY asset_id, face_index`;

/** One asset as the backfill composes it, straight off the two tables. */
export interface MeiliAssetRow {
  id: string;
  maple_id: string;
  deleted_at: string | null;
  hidden: number;
  is_screenshot: number | null;
  captured_at: string | null;
  captured_month: number | null;
  place: string | null;
  description: string | null;
  ocr_text: string | null;
  transcript: string | null;
  vision: string | null;
}

/** One face row, narrowed to what the people lookup needs plus its geometry. */
export interface MeiliFaceRow {
  asset_id: string;
  person_id: string | null;
  confidence: number;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
}

/** One page of assets with everything hanging off them, grouped by asset id. */
export interface MeiliAssetBatch {
  rows: MeiliAssetRow[];
  locations: Map<string, LocationRow[]>;
  faces: Map<string, MeiliFaceRow[]>;
}

const EMPTY_BATCH: MeiliAssetBatch = { rows: [], locations: new Map(), faces: new Map() };

/** Fills in the locations and faces for a page of assets the caller already chose. */
async function withRelations(db: SqliteDb, rows: MeiliAssetRow[]): Promise<MeiliAssetBatch> {
  if (rows.length === 0) return EMPTY_BATCH;
  const ids = rows.map((row) => row.id);
  const [locations, faces] = await Promise.all([
    db.read<LocationRow>(locationsByAssetIdsSql(ids.length), ids),
    db.read<MeiliFaceRow>(FACES_SQL(ids.length), ids),
  ]);
  return { rows, locations: groupByAsset(locations), faces: groupByAsset(faces) };
}

/**
 * The next `limit` indexable assets after `cursor`, in id order.
 *
 * `cursor === null` starts from the top, which is a separate statement rather
 * than a sentinel id so the first page is the same keyed scan every later page
 * is.
 */
export async function loadMeiliAssetsAfter(
  cursor: string | null,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<MeiliAssetBatch> {
  const db = sqliteDb(dbOverride);
  const rows =
    cursor === null
      ? await db.read<MeiliAssetRow>(ROWS_FROM_START_SQL, [limit])
      : await db.read<MeiliAssetRow>(ROWS_AFTER_SQL, [cursor, limit]);
  return withRelations(db, rows);
}

/**
 * The same shape for an explicit id list — the redrive pass re-reading the
 * assets behind its dead letters.
 *
 * Unlike the cursor pass this does not filter on `maple_id`: a dead letter
 * whose asset has since lost its dedup id is resolved by the redrive as "gone"
 * rather than left in the work list forever, and that decision needs the row.
 */
export async function loadMeiliAssetsByIds(
  ids: readonly string[],
  dbOverride?: SqliteDb,
): Promise<MeiliAssetBatch> {
  if (ids.length === 0) return EMPTY_BATCH;
  const db = sqliteDb(dbOverride);
  const rows = await db.read<MeiliAssetRow>(
    `SELECT ${ASSET_COLUMNS} ${ASSET_FROM} WHERE a.id IN (${placeholders(ids.length)})`,
    [...ids],
  );
  return withRelations(db, rows);
}

/** How many indexable assets remain after `cursor`. */
export async function countMeiliAssetsAfter(
  cursor: string | null,
  dbOverride?: SqliteDb,
): Promise<number> {
  const db = sqliteDb(dbOverride);
  const rows =
    cursor === null
      ? await db.read<{ n: number }>(COUNT_FROM_START_SQL)
      : await db.read<{ n: number }>(COUNT_AFTER_SQL, [cursor]);
  return rows[0]?.n ?? 0;
}

/**
 * Whether any indexable asset remains after `cursor`.
 *
 * One row rather than a count, because the caller only needs to know whether
 * the pass has reached the end of the library.
 */
export async function hasMeiliAssetsAfter(cursor: string, dbOverride?: SqliteDb): Promise<boolean> {
  const rows = await sqliteDb(dbOverride).read<{ id: string }>(EXISTS_AFTER_SQL, [cursor]);
  return rows.length > 0;
}

/** Stamp the fingerprint on the assets whose documents just landed in the index. */
export async function markAssetRowsVectorized(
  assetIds: readonly string[],
  fingerprint: string,
  dbOverride?: SqliteDb,
): Promise<void> {
  if (assetIds.length === 0) return;
  await sqliteDb(dbOverride).write(
    `UPDATE assets SET semantic_vector_fingerprint = ?
      WHERE id IN (${placeholders(assetIds.length)})`,
    [fingerprint, ...assetIds],
  );
}

/**
 * Carry coverage forward onto every live asset already marked with the same
 * document shape.
 *
 * `substr(...) = ?` rather than a `LIKE` pattern: the prefix is data, and an
 * exact-length comparison neither needs escaping nor depends on `LIKE`'s
 * case-folding rules. The `IS NOT NULL` alongside it is what lets
 * `assets_vector_fingerprint` — partial on live, marked rows — confine the scan
 * to the rows that could possibly match.
 */
export async function advanceVectorFingerprint(
  shapePrefix: string,
  fingerprint: string,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `UPDATE assets SET semantic_vector_fingerprint = ?
      WHERE ${LIVE_ASSET_PREDICATE}
        AND semantic_vector_fingerprint IS NOT NULL
        AND substr(semantic_vector_fingerprint, 1, ?) = ?`,
    [fingerprint, shapePrefix.length, shapePrefix],
  );
}

/** How many live assets there are — the denominator of vector coverage. */
export async function countLiveAssetRows(dbOverride?: SqliteDb): Promise<number> {
  const rows = await sqliteDb(dbOverride).read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM assets WHERE ${LIVE_ASSET_PREDICATE}`,
  );
  return rows[0]?.n ?? 0;
}

/** How many live assets carry exactly this fingerprint — the numerator. */
export async function countLiveAssetRowsWithFingerprint(
  fingerprint: string,
  dbOverride?: SqliteDb,
): Promise<number> {
  const rows = await sqliteDb(dbOverride).read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM assets
      WHERE ${LIVE_ASSET_PREDICATE} AND semantic_vector_fingerprint = ?`,
    [fingerprint],
  );
  return rows[0]?.n ?? 0;
}
