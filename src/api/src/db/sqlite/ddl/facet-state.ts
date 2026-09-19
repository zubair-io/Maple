/**
 * The mirrored facet state, and the indexes it makes possible (#3768, #3783).
 *
 * ## The problem, in one paragraph
 *
 * Six of the twelve aggregations behind `GET /api/search/facets` group a table
 * that is not `assets` — `asset_detail` for scene type and activity,
 * `asset_locations` for the extension, `faces` for people, and the `vision`
 * JSON for subjects. Each of those groups its own index cheaply and then has to
 * ask `assets` one question per candidate row: is this asset live, and is it
 * hidden. At 335,377 assets that is a few hundred thousand keyed probes, and it
 * is the whole cost: grouping the scene-type index alone measures 10 ms, and
 * the same grouping with the liveness join measures 264 ms. Making the probe
 * index-only (see `assets_live_id` below) takes it to 81 ms and no further —
 * the probe itself is the floor.
 *
 * ## What this module does instead
 *
 * Each of those tables carries the two facts about its asset that every facet
 * filters on, so the facet reads one index and stops:
 *
 * | column         | mirrors                                              |
 * | -------------- | ---------------------------------------------------- |
 * | `asset_live`   | `deleted_at IS NULL AND live_location_count > 0`      |
 * | `asset_hidden` | `assets.hidden`                                       |
 *
 * `asset_hidden` is a *column* of each facet index rather than part of its
 * `WHERE`, for the same reason `hidden` is on the `assets` facet indexes:
 * `hidden=only` and `hidden=all` are real wire values, and a partial index over
 * `asset_hidden = 0` would lose both. `asset_live` is in the `WHERE`, because no
 * caller can ask for dead assets.
 *
 * ## Why this is a mirror and not a hand-maintained field
 *
 * The schema already rejected one denormalised number — `people.face_count`,
 * adjusted by hand at four membership sites and healed by a fifth — and kept
 * another, `assets.live_location_count`, because triggers derive it and a write
 * path therefore cannot forget to update it. These columns are the second kind.
 * Every value comes from {@link FACET_STATE_TRIGGER_DDL}: one trigger on
 * `assets` that pushes a change out to the four satellites, and one per
 * satellite that seeds a new row from the asset it belongs to. No repository
 * writes them, so no repository can drift them, and
 * {@link FACET_STATE_RECOMPUTE_SQL} rebuilds all of it in one pass for the
 * importer's triggerless bulk load.
 *
 * ## `asset_subjects`
 *
 * The subjects facet is the one that no index could serve at all: it parses
 * `vision.subjects` out of the JSON for every matching asset, and SQLite cannot
 * index the elements of a JSON array. So the array becomes rows, the same shape
 * `faces` and `asset_locations` already have — and it is derived by trigger
 * from `asset_detail.vision` rather than written by the describe stage, so the
 * table cannot disagree with the payload it comes from.
 */

import { LIVE_ASSET_PREDICATE } from './assets.ts';

/** `assets.deleted_at IS NULL AND live_location_count > 0`, for the `NEW` row. */
const NEW_ASSET_LIVE = '(NEW.deleted_at IS NULL AND NEW.live_location_count > 0)';

/**
 * The same two facts read back out of `assets` for one asset id, as a pair of
 * scalar sub-selects.
 *
 * `COALESCE` because both columns are `NOT NULL`: a satellite row whose asset
 * is missing would otherwise abort the insert with a constraint failure rather
 * than simply being marked dead. The foreign keys make that unreachable while
 * `PRAGMA foreign_keys` is on, and the pragma is per connection.
 */
function seededFrom(assetIdExpression: string): string {
  return `asset_live = COALESCE((SELECT a.deleted_at IS NULL AND a.live_location_count > 0
                                   FROM assets a WHERE a.id = ${assetIdExpression}), 0),
        asset_hidden = COALESCE((SELECT a.hidden FROM assets a WHERE a.id = ${assetIdExpression}), 0)`;
}

/**
 * The extension of a filename, by the same expression the facet used to compute
 * per row.
 *
 * `rtrim`/`replace` is the standard SQLite idiom for "text after the last dot",
 * and it degenerates exactly the way `$split` + `$arrayElemAt: -1` did on
 * MongoDB: a name with no dot reports itself, and a name ending in a dot reports
 * the empty string. Both degenerate cases are excluded by the facet index's
 * `extension <> ''`… except the first, which is deliberate — `Makefile` reports
 * `makefile`, which is what the Mongo pipeline reported too. Kept verbatim so
 * the column and the expression it replaces cannot disagree about one filename.
 */
const FILENAME_EXTENSION = `lower(replace(filename, rtrim(filename, replace(filename, '.', '')), ''))`;

/**
 * `vision.subjects` as a JSON array, or an empty one.
 *
 * The `json_type` guard is not defensiveness for its own sake. `json_each`
 * raises on anything that is not JSON, and `json_extract(vision, '$.subjects')`
 * unwraps a JSON *string* into bare SQL text — so a payload carrying
 * `"subjects": "dog"` would hand `json_each` the five characters `dog` and
 * abort the describe stage's write, not merely fail to match. Only an array
 * reaches `json_each`; everything else contributes no rows.
 */
const SUBJECTS_ARRAY = `CASE WHEN json_type(%ROW%.vision, '$.subjects') = 'array'
                             THEN json_extract(%ROW%.vision, '$.subjects') ELSE '[]' END`;

/** The `INSERT … SELECT` a trigger runs to derive one asset's subject rows. */
const INSERT_SUBJECT_ROWS = `INSERT OR IGNORE INTO asset_subjects
    (asset_id, subject, asset_live, asset_hidden)
  SELECT NEW.asset_id, s.value,
         COALESCE((SELECT a.deleted_at IS NULL AND a.live_location_count > 0
                     FROM assets a WHERE a.id = NEW.asset_id), 0),
         COALESCE((SELECT a.hidden FROM assets a WHERE a.id = NEW.asset_id), 0)
    FROM json_each(${SUBJECTS_ARRAY.replaceAll('%ROW%', 'NEW')}) AS s
   WHERE s.type = 'text' AND s.value <> ''`;

/**
 * The columns added to the three existing satellite tables.
 *
 * `ALTER TABLE` rather than a change to each table's `CREATE TABLE`, because
 * the initial schema shipped at the cutover (#3752) and a migration id that has
 * run somewhere real is frozen — a database that recorded `0001-initial-schema`
 * never looks at it again, so an edit there would reach new installs only. The
 * cost is that a fresh install creates two indexes and then rebuilds them; the
 * benefit is that both kinds of database end up with the same schema, which is
 * the only property that matters.
 *
 * No `CHECK (… IN (0, 1))`, because SQLite cannot add one with `ALTER TABLE`.
 * Nothing but the triggers below ever writes these columns, which is a stronger
 * guarantee than a CHECK gives anyway.
 */
export const FACET_STATE_COLUMNS_DDL = `
ALTER TABLE asset_detail    ADD COLUMN asset_live   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE asset_detail    ADD COLUMN asset_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE asset_locations ADD COLUMN asset_live   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE asset_locations ADD COLUMN asset_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE faces           ADD COLUMN asset_live   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE faces           ADD COLUMN asset_hidden INTEGER NOT NULL DEFAULT 0;

-- The extension facet's group key, materialised so the index holds it. As an
-- expression it was recomputed for every live asset and the grouping needed a
-- temporary b-tree; as an indexed generated column it is neither.
ALTER TABLE asset_locations ADD COLUMN extension TEXT
  GENERATED ALWAYS AS (${FILENAME_EXTENSION}) VIRTUAL;
`;

/**
 * `vision.subjects`, as rows.
 *
 * A rowid table, deliberately, like `asset_detail`: the primary key is what the
 * `subjects=` filter probes by asset, and the facet index below is what the
 * facet scans, so the extra b-tree earns its place twice.
 */
export const ASSET_SUBJECTS_TABLE_DDL = `
CREATE TABLE asset_subjects (
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  subject  TEXT NOT NULL,

  -- Mirrored from the asset. See the module comment.
  asset_live   INTEGER NOT NULL DEFAULT 0 CHECK (asset_live IN (0, 1)),
  asset_hidden INTEGER NOT NULL DEFAULT 0 CHECK (asset_hidden IN (0, 1)),

  -- One row per (asset, subject). A payload that lists the same subject twice
  -- is one row, which is what makes the facet's count agree with the number of
  -- assets the matching filter returns — an array with a repeat used to count
  -- the asset twice in its own bucket.
  PRIMARY KEY (asset_id, subject)
);
`;

/**
 * The six facet indexes this ticket adds or reshapes, and the one probe index
 * behind every facet that still has to reach `assets`.
 *
 * Measured at 335,377 generated assets, median of five, against the statements
 * `repos/search.facets.sql.ts` generates for an unfiltered request:
 *
 * | facet         | before   | after   |
 * | ------------- | -------- | ------- |
 * | ISO range     | 265 ms   | 12 ms   |
 * | extensions    | 436 ms   | 11 ms   |
 * | scene type    | 264 ms   | 11 ms   |
 * | activity      | 464 ms   | 10 ms   |
 * | people        | 637 ms   | 27 ms   |
 * | subjects      | 617 ms   | 25 ms   |
 */
export const FACET_STATE_INDEX_DDL = `
-- Widened from (id) to (id, hidden). Every facet that still reaches 'assets' —
-- which is every one of them once a search carries a filter — probes this index
-- to ask "live, and visible?". Keyed on id alone it answered the first half
-- from the index and then read the whole asset row for the second: the people
-- facet measured 637 ms against 199 ms over 335,377 assets, purely on that.
-- The face-count probe in repos/people.sql.ts names this index explicitly and
-- is unaffected by the extra trailing column.
DROP INDEX IF EXISTS assets_live_id;
CREATE INDEX assets_live_id
  ON assets (id, hidden)
  WHERE ${LIVE_ASSET_PREDICATE};

-- The ISO range facet, and the isoMin/isoMax filter beside it. The schema
-- deliberately left ISO in the exif JSON with no index, on the grounds that
-- nothing groups or sorts on it; what that missed is that MIN/MAX over an
-- unindexed generated column re-parses the payload of every live asset —
-- 265 ms, against 12 ms for the same aggregate read out of this index.
CREATE INDEX assets_facet_iso
  ON assets (iso, hidden)
  WHERE ${LIVE_ASSET_PREDICATE};

-- The two vision facets, rebuilt over the mirrored state. asset_id trails the
-- group key so that the filtered shape — which keeps the join to 'assets' for
-- its residuals — reads the id out of this index rather than the detail row.
DROP INDEX IF EXISTS asset_detail_scene_type;
CREATE INDEX asset_detail_scene_type
  ON asset_detail (vision_scene_type, asset_hidden, asset_id)
  WHERE asset_live = 1 AND vision_scene_type IS NOT NULL;

DROP INDEX IF EXISTS asset_detail_activity;
CREATE INDEX asset_detail_activity
  ON asset_detail (vision_activity, asset_hidden, asset_id)
  WHERE asset_live = 1 AND vision_activity IS NOT NULL;

-- The extension facet. Partial over the canonical entry, because that is the
-- one the facet groups, and over a non-empty extension, which keeps the
-- degenerate "filename ends in a dot" rows out of the index rather than out of
-- a HAVING.
CREATE INDEX asset_locations_facet_extension
  ON asset_locations (extension, asset_hidden, asset_id)
  WHERE ordinal = 0 AND asset_live = 1 AND extension <> '';

-- The people facet. faces_person stays as it is — it serves the person filter
-- and the per-person face count, neither of which groups the whole table — and
-- this one adds the mirrored state the facet needs.
CREATE INDEX faces_facet_person
  ON faces (person_id, asset_hidden, asset_id)
  WHERE person_id IS NOT NULL AND hidden = 0 AND asset_live = 1;

CREATE INDEX asset_subjects_facet
  ON asset_subjects (subject, asset_hidden, asset_id)
  WHERE asset_live = 1;
`;

/**
 * Everything that keeps the mirrored columns true.
 *
 * One trigger pushes a change out of `assets`, and one per satellite pulls the
 * current state in when a row appears. Both halves are needed and neither is
 * redundant: an asset can be hidden long after its faces were detected, and a
 * face can be detected long after its asset was hidden.
 *
 * The `WHEN` guard on the outward trigger is what keeps this off the hot path.
 * `live_location_count` is itself rewritten by a trigger on every
 * `asset_locations` insert and delete, so without the guard every discovered
 * file would fan out into four keyed updates; with it, only a change that
 * actually flips liveness or visibility does — which is the first location an
 * asset gets, the last one it loses, a trash, a restore, and a hide.
 *
 * Nesting is fine and is relied on: the location trigger updates `assets`,
 * which fires this one, which updates `asset_locations`. SQLite's default
 * `recursive_triggers = off` only stops a trigger re-entering *itself*, and
 * the updates here name columns no trigger watches, so nothing re-enters.
 */
export const FACET_STATE_TRIGGER_DDL = `
CREATE TRIGGER assets_facet_state_au
AFTER UPDATE OF deleted_at, live_location_count, hidden ON assets
WHEN NEW.hidden <> OLD.hidden
  OR (NEW.deleted_at IS NULL) <> (OLD.deleted_at IS NULL)
  OR (NEW.live_location_count > 0) <> (OLD.live_location_count > 0)
BEGIN
  UPDATE asset_detail
     SET asset_live = ${NEW_ASSET_LIVE}, asset_hidden = NEW.hidden
   WHERE asset_id = NEW.id;
  UPDATE asset_locations
     SET asset_live = ${NEW_ASSET_LIVE}, asset_hidden = NEW.hidden
   WHERE asset_id = NEW.id;
  UPDATE faces
     SET asset_live = ${NEW_ASSET_LIVE}, asset_hidden = NEW.hidden
   WHERE asset_id = NEW.id;
  UPDATE asset_subjects
     SET asset_live = ${NEW_ASSET_LIVE}, asset_hidden = NEW.hidden
   WHERE asset_id = NEW.id;
END;

CREATE TRIGGER asset_detail_facet_state_ai AFTER INSERT ON asset_detail
BEGIN
  UPDATE asset_detail SET ${seededFrom('NEW.asset_id')} WHERE asset_id = NEW.asset_id;
END;

CREATE TRIGGER asset_locations_facet_state_ai AFTER INSERT ON asset_locations
BEGIN
  UPDATE asset_locations SET ${seededFrom('NEW.asset_id')} WHERE id = NEW.id;
END;

-- A duplicate merge repoints a location row at the surviving asset
-- (repos/assets.merge.ts), which is the one write that moves a satellite row
-- between two assets whose state can differ.
CREATE TRIGGER asset_locations_facet_state_au
AFTER UPDATE OF asset_id ON asset_locations
BEGIN
  UPDATE asset_locations SET ${seededFrom('NEW.asset_id')} WHERE id = NEW.id;
END;

CREATE TRIGGER faces_facet_state_ai AFTER INSERT ON faces
BEGIN
  UPDATE faces SET ${seededFrom('NEW.asset_id')} WHERE id = NEW.id;
END;

-- asset_subjects is derived from the payload rather than written beside it, so
-- the describe stage's upsert is the only writer it needs and the two cannot
-- disagree. The update arm re-derives the whole set, which is correct for an
-- edit that removes a subject as well as one that adds one.
CREATE TRIGGER asset_detail_subjects_ai AFTER INSERT ON asset_detail
BEGIN
  ${INSERT_SUBJECT_ROWS};
END;

CREATE TRIGGER asset_detail_subjects_au AFTER UPDATE OF vision ON asset_detail
BEGIN
  DELETE FROM asset_subjects WHERE asset_id = NEW.asset_id;
  ${INSERT_SUBJECT_ROWS};
END;

CREATE TRIGGER asset_detail_subjects_ad AFTER DELETE ON asset_detail
BEGIN
  DELETE FROM asset_subjects WHERE asset_id = OLD.asset_id;
END;
`;

/** Names of the triggers above, so a bulk load can drop them by name. */
export const FACET_STATE_TRIGGER_NAMES = [
  'assets_facet_state_au',
  'asset_detail_facet_state_ai',
  'asset_locations_facet_state_ai',
  'asset_locations_facet_state_au',
  'faces_facet_state_ai',
  'asset_detail_subjects_ai',
  'asset_detail_subjects_au',
  'asset_detail_subjects_ad',
] as const;

/**
 * Rebuilds every mirrored column and the whole of `asset_subjects` from
 * `assets` and `asset_detail`.
 *
 * Three callers: the migration that introduces the columns, the importer after
 * its triggerless bulk load, and any operator who doubts the mirror — the same
 * three `LIVE_LOCATION_COUNT_RECOMPUTE_SQL` has, and for the same reason. It is
 * a full pass, not an incremental repair, so running it twice costs time and
 * changes nothing.
 */
export const FACET_STATE_RECOMPUTE_SQL = `
UPDATE asset_detail SET ${seededFrom('asset_detail.asset_id')};
UPDATE asset_locations SET ${seededFrom('asset_locations.asset_id')};
UPDATE faces SET ${seededFrom('faces.asset_id')};
DELETE FROM asset_subjects;
INSERT OR IGNORE INTO asset_subjects (asset_id, subject, asset_live, asset_hidden)
SELECT d.asset_id, s.value,
       a.deleted_at IS NULL AND a.live_location_count > 0,
       a.hidden
  FROM asset_detail d
  JOIN assets a ON a.id = d.asset_id,
       json_each(${SUBJECTS_ARRAY.replaceAll('%ROW%', 'd')}) AS s
 WHERE s.type = 'text' AND s.value <> '';
`;
