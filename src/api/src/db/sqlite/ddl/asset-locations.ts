/**
 * `asset_locations` — the `fileinfo[]` array, normalised.
 *
 * One row per known on-disk location of an asset. `ordinal` preserves the
 * array position, so `ordinal = 0` is still the canonical entry that cache-path
 * resolution and the list DTO read.
 *
 * ## Why this is the table that fixes the ANY-location rule
 *
 * `fileinfo[]` sits behind 65 `$elemMatch` call sites, and the reason there are
 * that many is that MongoDB gives you two different answers for an array of
 * subdocuments and the difference is invisible at the call site:
 *
 *  - `{ fileinfo: { $elemMatch: { a: 1, b: 2 } } }` — one entry must satisfy
 *    BOTH conditions.
 *  - `{ 'fileinfo.a': 1, 'fileinfo.b': 2 }` — the conditions may be satisfied
 *    by DIFFERENT entries.
 *
 * Getting that wrong is a live bug today: `routes/backup-sidecar.ts` matches
 * `'phasset_links.device_id'` and `'phasset_links.phasset_local_id'` as dotted
 * paths, so an asset linked to `(deviceA, id1)` and `(deviceB, id2)` answers a
 * lookup for `(deviceA, id2)`. Every sibling route uses `$elemMatch`.
 *
 * In SQL the distinction cannot be written by accident, because an entry is a
 * row. Same-entry matching is a single `WHERE` on one row of this table:
 *
 *     SELECT 1 FROM asset_locations
 *      WHERE asset_id = ?1 AND library_id = ?2 AND path = ?3 AND filename = ?4
 *        AND deleted_at IS NULL AND missing_since IS NULL
 *
 * and any-entry matching is an explicit `EXISTS` or join. The rule stops being
 * subtle; it becomes the shape of the query.
 *
 * ## Liveness
 *
 * An entry is live when it carries neither `deleted_at` (its bytes were
 * replaced in place) nor `missing_since` (its file vanished from disk) — the
 * exact definition of `isLiveFileInfo`. Legacy Mongo rows wrote neither field,
 * which is why the helper used `{ $in: [null] }`; `IS NULL` covers both cases
 * natively here.
 *
 * ## Why `live_location_count` survives as a column
 *
 * The ticket retires it, and it does retire the thing that hurt: a
 * denormalised number hand-maintained at every liveness mutation site, which
 * could and did drift. The triggers below derive it, so it cannot.
 *
 * It survives because the facet aggregations need it. "Live asset" is the base
 * predicate of every facet, and written as an `EXISTS` sub-select it costs one
 * B-tree probe per candidate row — about 335,000 probes for a single facet,
 * which lands in the hundreds of milliseconds and misses the ticket's target.
 * As a column it folds into the partial-index `WHERE` clause, and the same
 * facet becomes an index-only scan. The PR body carries both measurements.
 */

export const ASSET_LOCATIONS_TABLE_DDL = `
CREATE TABLE asset_locations (
  -- Internal identity: no client ever sees a location id (a fileinfo entry has
  -- none today either), so this one is free to be a cheap rowid alias.
  id INTEGER PRIMARY KEY,

  asset_id  TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  -- Array position in the former fileinfo[]. 0 is the canonical entry.
  ordinal   INTEGER NOT NULL,

  library_id TEXT NOT NULL REFERENCES folders (id),
  -- Directory relative to the library root, POSIX-separated. '' at the root.
  path       TEXT NOT NULL,
  filename   TEXT NOT NULL,

  -- Non-live tags. Either one set means this location no longer holds the
  -- asset's content; both null means live.
  deleted_at      TEXT,
  missing_since   TEXT,
  missing_reason  TEXT,

  -- Operator '.keep' marker was present in this directory at index time.
  keep INTEGER NOT NULL DEFAULT 0 CHECK (keep IN (0, 1)),

  UNIQUE (asset_id, ordinal)
);
`;

export const ASSET_LOCATIONS_INDEX_DDL = `
-- Replaces fileinfo_lib_path_name_unique. Two assets cannot claim the same
-- file, and one asset cannot list the same file twice — the second guarantee
-- is stronger than the Mongo multikey index gave and is what we want.
CREATE UNIQUE INDEX asset_locations_lib_path_name
  ON asset_locations (library_id, path, filename);

-- Library scoping for browse and search. Partial over live entries because
-- every scoped read is also a live read.
CREATE INDEX asset_locations_library_live
  ON asset_locations (library_id, asset_id)
  WHERE deleted_at IS NULL AND missing_since IS NULL;

-- "Which assets have two or more live locations" — the deduplicate worker's
-- candidate set and its badge count. An index-only GROUP BY … HAVING COUNT(*)
-- >= 2, replacing the fileinfo.1 partial index plus the $expr/$filter pass
-- that had to run over every candidate row.
CREATE INDEX asset_locations_live_by_asset
  ON asset_locations (asset_id)
  WHERE deleted_at IS NULL AND missing_since IS NULL;

-- The 'name' sort on /api/search and /api/folders/:id, which the compound
-- (library_id, path, filename) key cannot serve because filename is not its
-- leading column.
CREATE INDEX asset_locations_filename
  ON asset_locations (filename);

-- Missing-reaper sweep and its /status count: entries tagged missing, oldest
-- first. Partial, so the index holds only the handful of tagged entries.
CREATE INDEX asset_locations_missing
  ON asset_locations (missing_since)
  WHERE missing_since IS NOT NULL;
`;

/**
 * Keeps `assets.live_location_count` in step with this table.
 *
 * Exported apart from the rest of the DDL so the importer can drop the triggers
 * for a bulk load, run {@link LIVE_LOCATION_COUNT_RECOMPUTE_SQL} once, and put
 * them back — 335,000 single-row `UPDATE`s during an import is a cost worth
 * avoiding, and the recompute is a single statement.
 *
 * `UPDATE OF` narrows the update trigger to the two columns that can change
 * liveness, so an ordinary path rename does not touch `assets` at all. The
 * update trigger also handles a row moving between assets, which is what a
 * duplicate merge does.
 */
export const ASSET_LOCATIONS_TRIGGER_DDL = `
CREATE TRIGGER asset_locations_count_ai AFTER INSERT ON asset_locations
BEGIN
  UPDATE assets SET live_location_count = (
    SELECT COUNT(*) FROM asset_locations
     WHERE asset_id = NEW.asset_id AND deleted_at IS NULL AND missing_since IS NULL
  ) WHERE id = NEW.asset_id;
END;

CREATE TRIGGER asset_locations_count_ad AFTER DELETE ON asset_locations
BEGIN
  UPDATE assets SET live_location_count = (
    SELECT COUNT(*) FROM asset_locations
     WHERE asset_id = OLD.asset_id AND deleted_at IS NULL AND missing_since IS NULL
  ) WHERE id = OLD.asset_id;
END;

CREATE TRIGGER asset_locations_count_au
AFTER UPDATE OF asset_id, deleted_at, missing_since ON asset_locations
BEGIN
  UPDATE assets SET live_location_count = (
    SELECT COUNT(*) FROM asset_locations
     WHERE asset_id = OLD.asset_id AND deleted_at IS NULL AND missing_since IS NULL
  ) WHERE id = OLD.asset_id;
  UPDATE assets SET live_location_count = (
    SELECT COUNT(*) FROM asset_locations
     WHERE asset_id = NEW.asset_id AND deleted_at IS NULL AND missing_since IS NULL
  ) WHERE id = NEW.asset_id;
END;
`;

/** Names of the triggers above, so the importer can drop them by name. */
export const ASSET_LOCATIONS_TRIGGER_NAMES = [
  'asset_locations_count_ai',
  'asset_locations_count_ad',
  'asset_locations_count_au',
] as const;

/**
 * Rebuilds every `assets.live_location_count` from `asset_locations` in one
 * statement. The importer runs this after a triggerless bulk load; it is also
 * the repair any operator can run if the column is ever doubted.
 */
export const LIVE_LOCATION_COUNT_RECOMPUTE_SQL = `
UPDATE assets SET live_location_count = COALESCE((
  SELECT COUNT(*) FROM asset_locations
   WHERE asset_locations.asset_id = assets.id
     AND asset_locations.deleted_at IS NULL
     AND asset_locations.missing_since IS NULL
), 0);
`;
