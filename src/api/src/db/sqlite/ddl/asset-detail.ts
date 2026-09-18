/**
 * `asset_detail` and `asset_phasset_links` — the payloads and links that hang
 * off an asset without belonging on its grid row.
 *
 * ## asset_detail
 *
 * The describe stage's output is the bulk of an asset document: a structured
 * `vision` object, a free-text caption, transcribed on-image text, a whole
 * video description with per-scene entries, and a speech transcript with
 * per-segment timings. Together they are most of the 8 KB average and all of
 * the 261 KB maximum, and a grid page reads none of them.
 *
 * So they live in a 1:1 side table keyed by asset. A detail view pays one extra
 * primary-key lookup; a grid page, a facet, a count and a stage claim pay
 * nothing, because they never touch this table at all. That separation is the
 * measurable half of "keep the grid table small enough to stay cached".
 *
 * They stay JSON, as the ticket asks. The two paths that queries reach into —
 * the scene and activity facets — get generated columns with indexes, so the
 * grouping is served by a small B-tree instead of a pass over every vision
 * object. Two details below are what make that true rather than plausible, and
 * both were found by measuring, after a review pointed out that the mapping
 * did not survive `EXPLAIN QUERY PLAN`.
 *
 * ## Why this one is NOT `WITHOUT ROWID`
 *
 * Every other keyed-by-one-value table in this schema is `WITHOUT ROWID`, and
 * this one started that way too. It cannot be, because of the two generated
 * columns: on a `WITHOUT ROWID` table SQLite will not answer a query from an
 * index over a generated column, so scanning `asset_detail_scene_type` fetches
 * each row and recomputes `json_extract` over its multi-kilobyte `vision`
 * payload — which is the exact cost this table exists to keep out of a facet.
 *
 * Measured, same data, same index, only the table declaration differing
 * (30,000 rows, a 2.4 KB payload each, SQLite 3.54):
 *
 * | table                 | GROUP BY over the generated column |
 * | --------------------- | ---------------------------------- |
 * | `WITHOUT ROWID`       | 69.8 ms                            |
 * | rowid                 | 1.0 ms                             |
 *
 * A plain (non-generated) column indexes as a covering index on either, at
 * 0.76 ms — so the penalty is specifically "generated column + WITHOUT ROWID",
 * and a rowid table gets within 30% of the ideal for free. The cost is one
 * extra B-tree for the primary key and one extra probe on the detail-view
 * lookup, against a facet that was 70x slower.
 *
 * What neither detail fixes is the liveness join. Grouping the index is cheap;
 * restricting the facet to live, non-hidden assets costs a probe between the
 * two tables per candidate, and that is where the time goes once the index
 * works — the benchmark reports the facet with and without it for exactly that
 * reason, and the gap is two orders of magnitude. Closing it would mean
 * liveness being visible from this table, a denormalisation the repository
 * port should argue for on its own evidence rather than one the schema assumes
 * ahead of a caller. Tracked rather than guessed; the numbers are in
 * docs/sqlite-schema.md.
 */
export const ASSET_DETAIL_TABLE_DDL = `
CREATE TABLE asset_detail (
  asset_id TEXT NOT NULL PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,

  -- The two facet columns, STORED and declared FIRST, which is the same rule
  -- the assets table follows for the opposite reason. SQLite reads a row's
  -- columns in declaration order and stops once it has what the statement
  -- asked for, so a facet that has to visit the row (see the note above)
  -- stops before the vision payload instead of reading and re-parsing it.
  -- VIRTUAL and declared last, the same query was 2.4x slower at no
  -- difference in table size, because every visit recomputed json_extract
  -- over the whole object.
  vision_scene_type TEXT GENERATED ALWAYS AS (json_extract(vision, '$.scene_type')) STORED,
  vision_activity   TEXT GENERATED ALWAYS AS (json_extract(vision, '$.activity')) STORED,

  -- Free-text caption, mirrored from vision.caption. Kept as its own column
  -- because it is returned verbatim and edited by the description override.
  description       TEXT,
  description_meta  TEXT CHECK (description_meta IS NULL OR json_valid(description_meta)),

  -- Text recognised in the image, mirrored from vision.text_visible.
  ocr_text  TEXT,
  ocr_meta  TEXT CHECK (ocr_meta IS NULL OR json_valid(ocr_meta)),

  vision       TEXT CHECK (vision IS NULL OR json_valid(vision)),
  vision_meta  TEXT CHECK (vision_meta IS NULL OR json_valid(vision_meta)),

  transcript              TEXT CHECK (transcript IS NULL OR json_valid(transcript)),
  video_description       TEXT CHECK (video_description IS NULL OR json_valid(video_description)),
  video_description_meta  TEXT CHECK (
                            video_description_meta IS NULL OR json_valid(video_description_meta)
                          ),

  -- Sparse user-edit overlay reconciled from the XMP sidecar.
  metadata_override TEXT CHECK (metadata_override IS NULL OR json_valid(metadata_override)),
  -- Per-stage derivative-audit cooldown marks.
  derivative_audit  TEXT CHECK (derivative_audit IS NULL OR json_valid(derivative_audit)),
  -- Provenance for GPS borrowed from a temporally-nearby photo.
  geo_inferred      TEXT CHECK (geo_inferred IS NULL OR json_valid(geo_inferred))
);
`;

export const ASSET_DETAIL_INDEX_DDL = `
-- The two vision facets on /api/search/facets. Both are full-collection
-- $group pipelines today with no index behind them.
--
-- Partial, and the facet query has to spell the predicate: a bare
-- 'GROUP BY vision_scene_type' does not imply 'vision_scene_type IS NOT NULL',
-- so it plans as a full SCAN of asset_detail — the largest object in the
-- database and the one this table exists to keep out of the page cache. The
-- query the route actually issues already excludes null and the empty string
-- ({ $nin: [null, ''] } in routes/search/facets.ts), which implies the index
-- predicate and uses the index; the exclusion is a facet-correctness rule
-- before it is an index rule, since neither value is a facet value.
CREATE INDEX asset_detail_scene_type
  ON asset_detail (vision_scene_type)
  WHERE vision_scene_type IS NOT NULL;

CREATE INDEX asset_detail_activity
  ON asset_detail (vision_activity)
  WHERE vision_activity IS NOT NULL;
`;

/**
 * `asset_phasset_links` — the per-device links to Apple Photos.
 *
 * This table exists to fix a specific recorded slowness. The backup sidecar
 * fallback looks an asset up by `(device_id, phasset_local_id)`, there is no
 * index on either field, and the slow-query log has that lookup scanning
 * 288,000 documents for 3 to 6 seconds. Here it is a two-column index seek.
 *
 * It also closes the correctness gap described in `./asset-locations.ts`: that
 * same route matches the pair as two dotted paths, so today an asset linked to
 * `(deviceA, id1)` and `(deviceB, id2)` wrongly answers a lookup for
 * `(deviceA, id2)`. One row, one device, one local id — the mismatch cannot be
 * expressed.
 */
export const ASSET_PHASSET_LINKS_TABLE_DDL = `
CREATE TABLE asset_phasset_links (
  id INTEGER PRIMARY KEY,

  asset_id  TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  -- PHAsset.localIdentifier — per-device, different on every device for the
  -- same iCloud photo.
  phasset_local_id TEXT NOT NULL,
  -- PHCloudIdentifier.stringValue — stable across every device on one iCloud
  -- account, which is what makes the merged timeline a join.
  phasset_cloud_id TEXT,
  first_seen TEXT NOT NULL,

  UNIQUE (asset_id, device_id, phasset_local_id)
);
`;

export const ASSET_PHASSET_LINKS_INDEX_DDL = `
-- The backup-sidecar fallback lookup. Indexed on BOTH columns because the
-- query binds both; this is the index that does not exist today.
CREATE INDEX asset_phasset_links_device_local
  ON asset_phasset_links (device_id, phasset_local_id);

-- Backup state delta: this device's links added since a cursor.
CREATE INDEX asset_phasset_links_device_seen
  ON asset_phasset_links (device_id, first_seen);

-- Cross-device join for the merged timeline.
CREATE INDEX asset_phasset_links_cloud
  ON asset_phasset_links (phasset_cloud_id)
  WHERE phasset_cloud_id IS NOT NULL;
`;
