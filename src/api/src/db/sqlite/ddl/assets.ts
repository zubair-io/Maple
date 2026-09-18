/**
 * The `assets` table — the narrow grid-and-filter row.
 *
 * This table is the whole performance argument for the migration, so its width
 * is a deliberate design constraint rather than an accident. On production
 * MongoDB the asset documents average 8 KB (p90 28 KB, max 261 KB) and occupy
 * 8.8 GB against a 1.5 GB cache, which is why counting the collection costs
 * about five seconds whether the cache is warm or cold. Copying that document
 * into one JSON column per row would reproduce the problem exactly.
 *
 * So three rules apply here, and a reviewer should push back when one is
 * broken:
 *
 *  1. **A field that a query filters, sorts or groups on is a column.** Either
 *     a stored column or a `GENERATED ALWAYS AS (json_extract(...)) VIRTUAL`
 *     column with an index — an indexed generated column materialises its value
 *     inside the index, so a facet or a sort never decodes the JSON at all.
 *  2. **A payload that is only ever read back whole lives somewhere else.**
 *     `vision`, `transcript`, `video_description`, `ocr_text` and friends are
 *     detail-view data; they live in `asset_detail` (see `./asset-detail.ts`)
 *     so they are not dragged through the page cache by a grid query.
 *  3. **The two JSON columns that stay (`exif`, `place`) are declared last.**
 *     SQLite reads a row's columns in declaration order and stops once it has
 *     what the statement asked for, so a query that selects only the narrow
 *     leading columns never follows the overflow pages these two can spill on
 *     to.
 *
 * Arrays are gone: `fileinfo[]`, `faces[]` and `phasset_links[]` are their own
 * tables, and the per-stage bookkeeping under `stages.<name>` is one
 * `stage_state` table. See the sibling modules.
 */

/**
 * Why `id` is TEXT and not an `INTEGER PRIMARY KEY` rowid alias.
 *
 * `db/assets.transform.ts` puts `doc._id.toHexString()` and the folder's hex id
 * straight into the DTOs the HTTP API returns, so those 24-character strings
 * are already part of the public contract. Apple, Web and Windows clients hold
 * them, compare them and derive cache keys from them — `trash.service.ts` on
 * web still has a `resolveMongoId()` path. The migration's stated non-goal is
 * that clients change, so the identifiers survive unchanged. Rowid aliases are
 * cheaper and are used freely by the internal tables whose ids never reach a
 * client.
 */
export const ASSETS_TABLE_DDL = `
CREATE TABLE assets (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  -- stat + provenance
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,
  indexed_at  TEXT    NOT NULL,

  -- sidecar-owned grid fields
  rating       INTEGER NOT NULL DEFAULT 0  CHECK (rating BETWEEN 0 AND 5),
  flag         INTEGER NOT NULL DEFAULT 0  CHECK (flag IN (-1, 0, 1)),
  color_label  TEXT    NOT NULL DEFAULT '',
  has_xmp      INTEGER NOT NULL DEFAULT 0  CHECK (has_xmp IN (0, 1)),
  sidecar_ver  INTEGER NOT NULL DEFAULT 0,

  media_kind TEXT NOT NULL DEFAULT 'image' CHECK (media_kind IN ('image', 'video', 'audio')),

  -- visibility
  hidden         INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  hidden_reason  TEXT CHECK (
                   hidden_reason IS NULL
                   OR hidden_reason IN ('manual', 'nudity', 'nudity-burst', 'folder')
                 ),
  hidden_ack     INTEGER NOT NULL DEFAULT 0 CHECK (hidden_ack IN (0, 1)),
  is_screenshot  INTEGER NOT NULL DEFAULT 0 CHECK (is_screenshot IN (0, 1)),

  -- soft delete
  deleted_at      TEXT,
  deleted_reason  TEXT CHECK (deleted_reason IS NULL OR deleted_reason = 'reaped'),
  original_path   TEXT,

  -- "damaged file" tag. Flattened out of the 'damaged' subdocument because
  -- 'damaged.since' is a claim-query gate on EVERY stage: it has to be a real
  -- column, and the other two fields are three bytes of company.
  damaged_since   TEXT,
  damaged_stage   TEXT,
  damaged_reason  TEXT,

  -- content identity
  maple_id   TEXT,
  sha1_head  TEXT,

  -- liveness roll-up. Number of asset_locations rows for this asset with
  -- neither deleted_at nor missing_since set, maintained by the triggers in
  -- ./asset-locations.ts. See that module for why a derived column beat an
  -- EXISTS sub-select here.
  live_location_count INTEGER NOT NULL DEFAULT 0,

  -- backup / mirror bookkeeping
  deleted_from_photos          INTEGER NOT NULL DEFAULT 0 CHECK (deleted_from_photos IN (0, 1)),
  apple_rendered_path          TEXT,
  cf_thumb_synced_at           TEXT,
  semantic_vector_fingerprint  TEXT,

  -- one-shot migration generation markers ({ $ne: N } sweeps)
  backup_layout_version            INTEGER,
  legacy_daydir_version            INTEGER,
  video_meta_version               INTEGER,
  video_poster_rearm_version       INTEGER,
  video_screenshot_clear_version   INTEGER,
  preview_missing_redrive_version  INTEGER,
  geo_backfill_skipped             TEXT CHECK (
                                     geo_backfill_skipped IS NULL
                                     OR geo_backfill_skipped IN ('no-donor', 'skip')
                                   ),

  -- Legacy per-stage bookkeeping for the three Phase-2 stages, kept verbatim
  -- because toDetailDto returns it on the wire. The queryable half lives in
  -- enrichment_state; this is the DTO mirror.
  enrichment TEXT CHECK (enrichment IS NULL OR json_valid(enrichment)),

  -- JSON payloads, declared last so a narrow SELECT stops reading before them.
  exif   TEXT CHECK (exif IS NULL OR json_valid(exif)),
  place  TEXT CHECK (place IS NULL OR json_valid(place)),

  -- Generated columns over the JSON paths that queries actually touch. VIRTUAL
  -- costs no storage; the indexes below materialise the values they need.
  captured_at         TEXT    GENERATED ALWAYS AS (json_extract(exif, '$.captured_at')) VIRTUAL,
  captured_year       INTEGER GENERATED ALWAYS AS (json_extract(exif, '$.captured_year')) VIRTUAL,
  captured_month      INTEGER GENERATED ALWAYS AS (json_extract(exif, '$.captured_month')) VIRTUAL,
  camera_make         TEXT    GENERATED ALWAYS AS (json_extract(exif, '$.camera_make')) VIRTUAL,
  camera_model        TEXT    GENERATED ALWAYS AS (json_extract(exif, '$.camera_model')) VIRTUAL,
  camera_serial       TEXT    GENERATED ALWAYS AS (json_extract(exif, '$.camera_serial')) VIRTUAL,
  lens                TEXT    GENERATED ALWAYS AS (json_extract(exif, '$.lens')) VIRTUAL,
  iso                 INTEGER GENERATED ALWAYS AS (json_extract(exif, '$.iso')) VIRTUAL,
  gps_lat             REAL    GENERATED ALWAYS AS (json_extract(exif, '$.gps.lat')) VIRTUAL,
  gps_lng             REAL    GENERATED ALWAYS AS (json_extract(exif, '$.gps.lng')) VIRTUAL,
  place_country_code  TEXT    GENERATED ALWAYS AS (json_extract(place, '$.rollups.country_code')) VIRTUAL,
  place_region        TEXT    GENERATED ALWAYS AS (json_extract(place, '$.rollups.region')) VIRTUAL,
  place_locality      TEXT    GENERATED ALWAYS AS (json_extract(place, '$.rollups.locality')) VIRTUAL,
  geocoder_version    INTEGER GENERATED ALWAYS AS (json_extract(place, '$.geocoder_version')) VIRTUAL
);
`;

/**
 * "Live" in the sense every browse, search and facet surface means it: not
 * soft-deleted, and holding at least one location whose file is still there.
 *
 * Repeated verbatim in each partial index's `WHERE` clause because SQLite only
 * uses a partial index when the query's own `WHERE` provably implies the
 * index's. Repo modules must spell the predicate exactly this way.
 */
export const LIVE_ASSET_PREDICATE = 'deleted_at IS NULL AND live_location_count > 0';

export const ASSETS_INDEX_DDL = `
-- Default search/browse sort: newest capture first, id breaking ties so
-- pagination is stable across pages of burst frames. Replaces
-- { 'fileinfo.library_id': 1, 'exif.captured_at': -1, _id: 1 } — the library
-- scope is now a semi-join against asset_locations, which under a LIMIT costs
-- one index probe per returned row instead of leading the compound key.
CREATE INDEX assets_live_captured
  ON assets (captured_at DESC, id)
  WHERE ${LIVE_ASSET_PREDICATE};

-- Plain "how many live assets" count. Narrowest possible key so the count is a
-- scan of an index that fits in the page cache, never a table scan.
CREATE INDEX assets_live
  ON assets (id)
  WHERE ${LIVE_ASSET_PREDICATE};

-- Facet group-bys. Covering: the group keys ARE the index columns, so these
-- run as index-only scans and never read an asset row.
CREATE INDEX assets_facet_camera
  ON assets (camera_make, camera_model)
  WHERE ${LIVE_ASSET_PREDICATE};

CREATE INDEX assets_facet_lens
  ON assets (lens)
  WHERE ${LIVE_ASSET_PREDICATE};

CREATE INDEX assets_facet_place
  ON assets (place_country_code, place_region, place_locality)
  WHERE ${LIVE_ASSET_PREDICATE};

CREATE INDEX assets_facet_screenshot
  ON assets (is_screenshot)
  WHERE ${LIVE_ASSET_PREDICATE};

-- Timeline buckets: $group by { captured_year, captured_month }.
CREATE INDEX assets_live_captured_ym
  ON assets (captured_year DESC, captured_month DESC)
  WHERE ${LIVE_ASSET_PREDICATE};

-- Meilisearch live-vector coverage: countDocuments(LIVE_ASSET_FILTER +
-- semantic_vector_fingerprint). Unindexed on Mongo today, so this is new.
CREATE INDEX assets_vector_fingerprint
  ON assets (semantic_vector_fingerprint)
  WHERE ${LIVE_ASSET_PREDICATE} AND semantic_vector_fingerprint IS NOT NULL;

-- Trash GC sweep: deleted_at < cutoff. Partial so the index holds only the
-- trashed rows, exactly like the deleted_at_1 partial index it replaces.
CREATE INDEX assets_trashed
  ON assets (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- Content-dedup key. UNIQUE + partial mirrors maple_id_gt_1: skeleton rows
-- carry a null maple_id and must not collide with each other.
CREATE UNIQUE INDEX assets_maple_id
  ON assets (maple_id)
  WHERE maple_id IS NOT NULL AND maple_id <> '';

-- Secondary dedup fallback when the maple_id lookup misses. Not unique —
-- legacy rows can share a head hash.
CREATE INDEX assets_sha1_head
  ON assets (sha1_head)
  WHERE sha1_head IS NOT NULL;

-- Damaged tag: the /api/workers damaged list and count. The claim query's
-- exclusion (damaged_since IS NULL) is served by the partial stage indexes.
CREATE INDEX assets_damaged
  ON assets (damaged_since)
  WHERE damaged_since IS NOT NULL;

-- "Newly hidden, not yet acknowledged" review list and its badge count.
CREATE INDEX assets_hidden_pending
  ON assets (hidden_ack)
  WHERE hidden = 1;

-- Video/audio claim filters and the media-scoped migrations. Partial over the
-- minority kinds, so image rows never enter the index (#3492).
CREATE INDEX assets_media_kind_av
  ON assets (media_kind)
  WHERE media_kind IN ('video', 'audio');

-- Map clusters: a bbox range on both coordinates.
CREATE INDEX assets_gps_bbox
  ON assets (gps_lat, gps_lng)
  WHERE gps_lat IS NOT NULL;

-- apply-video-geo-backfill donor lookup: a ±15 minute capture-time window
-- among GPS-bearing assets.
CREATE INDEX assets_gps_captured
  ON assets (captured_at, gps_lat)
  WHERE gps_lat IS NOT NULL;

-- One-shot refile-backups sweep ({ $ne: BACKUP_LAYOUT_VERSION } over
-- backup-origin assets). Droppable once that cleanup finishes library-wide,
-- same as the Mongo index it replaces.
CREATE INDEX assets_backup_layout
  ON assets (backup_layout_version);
`;
