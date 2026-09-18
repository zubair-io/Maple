/**
 * Every statement the people and faces repositories run, with the index each
 * one leans on (#3749).
 *
 * Collected here for the same reason `assets.sql.ts` collects its own: a query
 * whose plan matters should be readable next to the index that serves it, not
 * buried in the function that happens to call it.
 *
 * Two spellings are load-bearing and must not be paraphrased.
 *
 * `LIVE_ASSET_PREDICATE` is imported rather than retyped. SQLite only uses a
 * partial index when the query's own `WHERE` provably implies the index's, and
 * the implication test is textual enough that an equivalent rewrite loses the
 * index — `docs/sqlite-schema.md` § the live-asset predicate has the argument.
 *
 * `name_key` appears in every name comparison and never `name` itself. The
 * Mongo index it replaces is declared with `{ locale: 'en', strength: 2 }`, and
 * the merge-on-duplicate-name behaviour is only correct if two spellings that
 * collide there collide here — which rules out `COLLATE NOCASE`, since that
 * folds ASCII and leaves "josé" and "JOSÉ" as two people. Every parameter
 * compared against `name_key`, and every value written to it, comes from
 * `caseFoldKey`. See `db/sqlite/case-fold.ts`.
 */

import { LIVE_ASSET_PREDICATE } from '../ddl/assets.ts';

/** The `people` columns every read selects, in one place so they cannot drift. */
export const PERSON_COLUMNS = `
  id, name, created_at, updated_at,
  cover_asset_id, cover_bbox_x, cover_bbox_y, cover_bbox_w, cover_bbox_h,
  merged_into, hidden, excluded,
  centroid, centroid_face_count,
  suggested_merge_person_id, suggested_merge_score, suggested_merges`;

/** A `?` placeholder list of the given length. */
export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

// ---------------------------------------------------------------------------
// People reads
// ---------------------------------------------------------------------------

/** One person by id. Primary key. */
export const PERSON_BY_ID_SQL = `SELECT ${PERSON_COLUMNS} FROM people WHERE id = ?`;

/** A batch of people by id, for the merge path's bulk fetch. Primary key. */
export function peopleByIdsSql(count: number): string {
  return `SELECT ${PERSON_COLUMNS} FROM people WHERE id IN (${placeholders(count)})`;
}

/**
 * The live person holding this name, case-insensitively — the lookup that makes
 * "rename onto an existing name" a merge.
 *
 * The parameter is a folded key, not a display name. This is the query
 * `people_name_unique` is declared over, so the lookup and the constraint
 * behind it agree by construction: whatever this misses, the index permits.
 */
export const LIVE_PERSON_BY_NAME_SQL = `
  SELECT ${PERSON_COLUMNS} FROM people
   WHERE name_key = ? AND merged_into IS NULL
   LIMIT 1`;

/**
 * An auto-generated "Person 12" name, as the Mongo `/^Person \\d+$/` anchors it.
 *
 * Two GLOBs rather than one because GLOB has no "digits only, to the end"
 * form: the first requires a digit right after the space, the second rejects
 * anything with a non-digit anywhere after it. Together they accept exactly a
 * space-then-digits tail, leading zeros included, which is what the regex
 * accepts too.
 */
const AUTO_NAME_PREDICATE = `(name GLOB 'Person [0-9]*' AND NOT name GLOB 'Person *[^0-9]*')`;

/**
 * One visibility-scoped listing, name-sorted.
 *
 * `predicate` is assembled by the caller from a fixed set of fragments, never
 * from request input. The sort is on the folded key so the order ignores case
 * the way the Mongo collation does, rather than SQLite's default byte order,
 * which would put every capitalised name ahead of every lowercase one. `id`
 * breaks the remaining ties, so a page is stable across calls — two people
 * whose names differ only in case sort in a fixed order rather than an
 * arbitrary one.
 */
export function listPeopleSql(predicate: string): string {
  return `SELECT ${PERSON_COLUMNS} FROM people
           WHERE ${predicate}
           ORDER BY name_key, id`;
}

/**
 * Live, visible people holding any of these exact names.
 *
 * The parameters are folded keys, like every other name comparison here.
 * Deliberately not filtered on `excluded`, matching the Mongo filter.
 */
export function livePersonIdsForNamesSql(count: number): string {
  return `SELECT id FROM people
           WHERE name_key IN (${placeholders(count)})
             AND merged_into IS NULL
             AND hidden = 0`;
}

/**
 * Names for a batch of person ids, excluding auto-generated "Person N" names so
 * they drop out of the facet picker exactly as the Mongo `$not` regex drops
 * them.
 */
export function personNamesByIdsSql(count: number): string {
  return `SELECT id, name FROM people
           WHERE id IN (${placeholders(count)})
             AND merged_into IS NULL
             AND hidden = 0
             AND NOT ${AUTO_NAME_PREDICATE}`;
}

/** Ids of every person carrying a visibility flag, regardless of merge state. */
export function flaggedPersonIdsSql(column: 'hidden' | 'excluded'): string {
  return `SELECT id FROM people WHERE ${column} = 1`;
}

/**
 * The highest "Person N" suffix in use, so new auto-names extend the run rather
 * than collide. `CAST` of the numeric tail; rows that are not auto-named are
 * excluded by the same GLOB pair used above.
 */
export const MAX_AUTO_NAME_INDEX_SQL = `
  SELECT MAX(CAST(substr(name, 8) AS INTEGER)) AS max_index
    FROM people
   WHERE ${AUTO_NAME_PREDICATE}`;

// ---------------------------------------------------------------------------
// Face counts — derived, never stored
// ---------------------------------------------------------------------------

/**
 * Live assigned faces per person: the count that used to be a maintained
 * `face_count` field.
 *
 * "Live" is the same three conditions the Mongo aggregation applies — the face
 * is not hidden, its asset is live, and the person is not merged away — but as
 * a join it is one grouped index scan instead of an `$unwind` of every asset's
 * faces array. `faces_person` is a partial index on
 * `(person_id, asset_id) WHERE person_id IS NOT NULL AND hidden = 0`, so the
 * predicate below is written to imply it exactly.
 *
 * `INDEXED BY assets_live_id` is the same deliberate instruction `listItemsSql`
 * gives, for the same reason: without it the planner takes the primary key's
 * implicit unique index, which finds the rowid and then reads the whole asset
 * row to test two columns — once per assigned face. Keyed on `id` with the
 * predicate folded in, the probe never leaves the index. On a generated
 * 335,377-asset library that is 591 ms against 175 ms, and the planner only
 * finds the better plan on its own once `ANALYZE` has run, which is not
 * something a query on the request path should depend on.
 */
export const FACE_COUNTS_BY_PERSON_SQL = `
  SELECT f.person_id AS person_id, COUNT(*) AS n
    FROM faces f
    JOIN assets a INDEXED BY assets_live_id ON a.id = f.asset_id
   WHERE f.person_id IS NOT NULL AND f.hidden = 0
     AND a.${LIVE_ASSET_PREDICATE}
   GROUP BY f.person_id`;

/**
 * The same count, for a named handful of people rather than all of them.
 *
 * The two forms answer the same question and differ only in how much of
 * `faces_person` they touch: this one seeks straight to each named person,
 * where the grouped form above walks every assigned face in the library. The
 * Hidden and Excluded listings are a dozen rows against a person table of tens
 * of thousands, so the difference there is the whole face table versus a dozen
 * seeks — see `people.face-count.ts` for which listing gets which.
 *
 * `person_id IN (…)` implies `person_id IS NOT NULL`, so the partial index
 * still applies and the seek stays index-only.
 */
export function faceCountsForPeopleSql(count: number): string {
  return `
  SELECT f.person_id AS person_id, COUNT(*) AS n
    FROM faces f
    JOIN assets a INDEXED BY assets_live_id ON a.id = f.asset_id
   WHERE f.person_id IN (${placeholders(count)}) AND f.hidden = 0
     AND a.${LIVE_ASSET_PREDICATE}
   GROUP BY f.person_id`;
}

/** The same count for one person. */
export const FACE_COUNT_FOR_PERSON_SQL = `
  SELECT COUNT(*) AS n
    FROM faces f
    JOIN assets a INDEXED BY assets_live_id ON a.id = f.asset_id
   WHERE f.person_id = ? AND f.hidden = 0
     AND a.${LIVE_ASSET_PREDICATE}`;

// ---------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------

const FACE_COLUMNS = `
  asset_id, face_index, person_id, confidence,
  bbox_x, bbox_y, bbox_w, bbox_h,
  hidden, landmarks, embedding, embedding_version`;

/** Every face on one asset, in array order. `faces` UNIQUE (asset_id, face_index). */
export const FACES_BY_ASSET_SQL = `
  SELECT ${FACE_COLUMNS} FROM faces WHERE asset_id = ? ORDER BY face_index`;

/** One face addressed the way clients address it. UNIQUE (asset_id, face_index). */
export const FACE_BY_ADDRESS_SQL = `
  SELECT ${FACE_COLUMNS} FROM faces WHERE asset_id = ? AND face_index = ?`;

/** How many faces an asset has, for the "index out of range" check. */
export const FACE_COUNT_ON_ASSET_SQL = `SELECT COUNT(*) AS n FROM faces WHERE asset_id = ?`;

/** Whether an asset row exists at all, for the "asset not found" check. */
export const ASSET_EXISTS_SQL = `SELECT id FROM assets WHERE id = ? LIMIT 1`;

export const SET_FACE_PERSON_SQL = `UPDATE faces SET person_id = ? WHERE asset_id = ? AND face_index = ?`;

/** Hide writes both fields together — a hidden face is never left assigned. */
export const HIDE_FACE_SQL = `
  UPDATE faces SET hidden = 1, person_id = NULL WHERE asset_id = ? AND face_index = ?`;

/** Repoint every one of a merged-away person's faces at the survivor. `faces_person`. */
export const REPOINT_FACES_SQL = `UPDATE faces SET person_id = ? WHERE person_id = ?`;

/**
 * One page of a person's faces, newest capture first.
 *
 * The liveness filter has to be applied before the ordering rather than after
 * (#2103 on the Mongo side, where a `$unwind` ahead of the `$match` paged over
 * rows that were then thrown away). As a join there is no staged pipeline to
 * get wrong: the predicate and the `ORDER BY` describe one query and SQLite
 * applies them in the only order that answers it.
 */
export const PERSON_FACE_PAGE_SQL = `
  SELECT f.asset_id AS asset_id, f.face_index AS face_index,
         f.bbox_x AS bbox_x, f.bbox_y AS bbox_y, f.bbox_w AS bbox_w, f.bbox_h AS bbox_h,
         f.confidence AS confidence
    FROM faces f
    JOIN assets a ON a.id = f.asset_id
   WHERE f.person_id = ? AND f.hidden = 0
     AND a.${LIVE_ASSET_PREDICATE}
   ORDER BY a.captured_at DESC, a.id ASC
   LIMIT ? OFFSET ?`;

/**
 * The highest-confidence unhidden face per person, for the cover backfill.
 *
 * A window function rather than `GROUP BY` with bare columns: SQLite leaves the
 * value of an ungrouped column undefined except for the `min`/`max` special
 * case, so grouping would pick a row the query does not actually name. Ties
 * break on `(asset_id, face_index)`, which makes a re-run pick the same cover
 * — the Mongo aggregation's tie-break is insertion order and therefore
 * reproducible only by accident.
 */
export function bestCoverFacesSql(count: number): string {
  return `SELECT person_id, asset_id, bbox_x, bbox_y, bbox_w, bbox_h FROM (
            SELECT f.person_id AS person_id, f.asset_id AS asset_id,
                   f.bbox_x AS bbox_x, f.bbox_y AS bbox_y,
                   f.bbox_w AS bbox_w, f.bbox_h AS bbox_h,
                   ROW_NUMBER() OVER (
                     PARTITION BY f.person_id
                     ORDER BY f.confidence DESC, f.asset_id ASC, f.face_index ASC) AS rank
              FROM faces f
             WHERE f.person_id IN (${placeholders(count)}) AND f.hidden = 0
          ) WHERE rank = 1`;
}

// ---------------------------------------------------------------------------
// Clustering load stage
// ---------------------------------------------------------------------------

/**
 * Every un-merged person's centroid state, in id order.
 *
 * Deliberately not filtered on `hidden` or `excluded`: a marked person stays a
 * clustering seed so their newly detected faces keep being absorbed by them
 * rather than spawning a fresh visible cluster. The two flags are selected only
 * so the merge-suggestion pass can exclude them without a second query.
 *
 * The `ORDER BY` is load-bearing. Cluster ids are positions in the seed list,
 * so the order centroids load in decides which person each id refers to, and
 * online clustering is order-sensitive besides. Mongo returns these in
 * collection order, which is `_id` order; this says that out loud rather than
 * relying on a table scan happening to agree.
 */
export const LIVE_CENTROIDS_SQL = `
  SELECT id, centroid, centroid_face_count, hidden, excluded
    FROM people WHERE merged_into IS NULL
   ORDER BY id`;

/**
 * Every unhidden embedding assigned to one of the named people, for the
 * centroid recompute. `faces_person` covers the `person_id` lookup; the
 * embedding itself is read off the row.
 */
export function assignedEmbeddingsSql(count: number): string {
  return `SELECT person_id, embedding FROM faces
           WHERE person_id IN (${placeholders(count)})
             AND hidden = 0
             AND embedding IS NOT NULL`;
}

/**
 * Every unassigned, unhidden face carrying an embedding — the clustering pass's
 * input, ordered so the pass is reproducible.
 *
 * Order is part of the contract, not a nicety: online clustering is
 * order-sensitive, so the same library must present its faces in the same
 * sequence on every run or two runs disagree. Mongo's aggregation returned them
 * in collection order, which is insertion order by `_id`; `(asset_id,
 * face_index)` is that same order, spelled explicitly. `faces_unassigned`.
 */
export const UNASSIGNED_FACES_SQL = `
  SELECT asset_id, face_index, bbox_x, bbox_y, bbox_w, bbox_h, embedding
    FROM faces
   WHERE person_id IS NULL AND hidden = 0 AND embedding IS NOT NULL
   ORDER BY asset_id, face_index`;

// ---------------------------------------------------------------------------
// People writes
// ---------------------------------------------------------------------------

export const INSERT_PERSON_SQL = `
  INSERT INTO people (id, name, name_key, created_at, updated_at, merged_into)
  VALUES (?, ?, ?, ?, ?, NULL)`;

/**
 * A person the clustering pass just discovered: named, seeded with the cluster's
 * centroid, and covered by the face that opened it.
 *
 * One statement rather than an insert followed by two updates, so a pass that
 * dies part-way cannot leave a nameless person with no centroid sitting in the
 * listing.
 */
export const INSERT_CLUSTER_PERSON_SQL = `
  INSERT INTO people
    (id, name, name_key, created_at, updated_at, merged_into,
     centroid, centroid_face_count,
     cover_asset_id, cover_bbox_x, cover_bbox_y, cover_bbox_w, cover_bbox_h)
  VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`;

/** Live people with no usable cover yet — no asset, or an asset with no crop. */
export const PEOPLE_MISSING_COVER_SQL = `
  SELECT id FROM people
   WHERE merged_into IS NULL
     AND (cover_asset_id IS NULL OR cover_bbox_x IS NULL)`;

/** A rename writes both spellings together: the key can never lag the name. */
export const RENAME_PERSON_SQL = `
  UPDATE people SET name = ?, name_key = ?, updated_at = ? WHERE id = ?`;

/** Touch a person and force its centroid to be recomputed on the next pass. */
export const DIRTY_CENTROID_SQL = `
  UPDATE people SET centroid_face_count = -1, updated_at = ? WHERE id = ?`;

export const SET_CENTROID_SQL = `
  UPDATE people SET centroid = ?, centroid_face_count = ? WHERE id = ?`;

export function setVisibilitySql(column: 'hidden' | 'excluded'): string {
  return `UPDATE people SET ${column} = ?, updated_at = ? WHERE id = ?`;
}

export const SET_COVER_SQL = `
  UPDATE people
     SET cover_asset_id = ?, cover_bbox_x = ?, cover_bbox_y = ?,
         cover_bbox_w = ?, cover_bbox_h = ?, updated_at = ?
   WHERE id = ?`;

/** Mark the orphan of a merge. The survivor is named by a separate statement. */
export const MARK_MERGED_SQL = `
  UPDATE people
     SET merged_into = ?, updated_at = ?,
         suggested_merge_person_id = NULL, suggested_merge_score = NULL
   WHERE id = ?`;

/** Clear every third party still pointing its suggestion head at the orphan. */
export const CLEAR_SUGGESTIONS_POINTING_AT_SQL = `
  UPDATE people
     SET suggested_merge_person_id = NULL, suggested_merge_score = NULL
   WHERE suggested_merge_person_id = ?`;

/** Name the survivor and dirty its centroid, in one statement. */
export const CLAIM_SURVIVOR_SQL = `
  UPDATE people
     SET name = ?, name_key = ?, updated_at = ?, centroid_face_count = -1
   WHERE id = ?`;

export const SET_SUGGESTION_SQL = `
  UPDATE people
     SET suggested_merge_person_id = ?, suggested_merge_score = ?, suggested_merges = ?
   WHERE id = ?`;

// ---------------------------------------------------------------------------
// Merge dismissals
// ---------------------------------------------------------------------------

/** Permanent and never deleted, so the insert ignores a repeat dismissal. */
export const INSERT_DISMISSAL_SQL = `
  INSERT INTO person_merge_dismissals (pair, created_at) VALUES (?, ?)
  ON CONFLICT (pair) DO NOTHING`;

export const ALL_DISMISSALS_SQL = `SELECT pair FROM person_merge_dismissals`;

export function dismissalsForPairsSql(count: number): string {
  return `SELECT pair FROM person_merge_dismissals WHERE pair IN (${placeholders(count)})`;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * The primary location of each named asset, with its library root and slug.
 *
 * "Primary" is the first fully live entry by `ordinal`, falling back to entry
 * zero — the same rule `resolvePrimary` applies to a rebuilt `fileinfo[]`, and
 * the same one `assetAbsPath` applies on Mongo. Expressed as a window function
 * rather than a correlated sub-select so it stays one pass over the rows.
 *
 * Shared by the people grid's cover thumbnails and the person detail page's
 * face list — both need "where does this asset live" for a batch of ids, and
 * an asset whose library is no longer registered yields no row from the join,
 * which is what both callers read as "unresolvable, drop it".
 */
export function primaryLocationsSql(count: number): string {
  return `SELECT asset_id, path, filename, root, slug FROM (
            SELECT l.asset_id AS asset_id, l.path AS path, l.filename AS filename,
                   d.path AS root, d.slug AS slug,
                   ROW_NUMBER() OVER (
                     PARTITION BY l.asset_id
                     ORDER BY (l.deleted_at IS NULL AND l.missing_since IS NULL) DESC,
                              l.ordinal ASC) AS rank
              FROM asset_locations l
              JOIN folders d ON d.id = l.library_id
             WHERE l.asset_id IN (${placeholders(count)})
          ) WHERE rank = 1`;
}
