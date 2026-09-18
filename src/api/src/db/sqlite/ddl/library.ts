/**
 * Library-level tables: registered roots, the File Provider change feed, the
 * server-wide key/value singletons, the mirror copy queue, the geocode cache
 * and user presets.
 *
 * Nothing here is per-asset, so nothing here is on the hot path the rest of the
 * schema is shaped around. The rule that does apply is the id rule: `folders`
 * and `presets` ids reach clients (a folder id is `folder_id` in every asset
 * DTO), so they are TEXT holding the same 24-character hex MongoDB produced.
 */

export const FOLDERS_TABLE_DDL = `
CREATE TABLE folders (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  -- Absolute filesystem path to the library root.
  path  TEXT NOT NULL UNIQUE,
  -- Stable public identifier, [a-z0-9-]. Minted once, never auto-changes.
  slug  TEXT NOT NULL UNIQUE,
  -- Display label; free to change.
  label TEXT NOT NULL,

  last_scan  TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,

  -- Backup/mirror roots for this library. A short list of { path, enabled }
  -- read whole by the mirror registry at boot; nothing filters into it.
  mirrors TEXT CHECK (mirrors IS NULL OR json_valid(mirrors))
);
`;

/**
 * The File Provider push channel. `cursor` is allocated from the
 * `asset_changes_cursor` row of `server_state` and is the ordering contract —
 * `at` is informational.
 */
export const ASSET_CHANGES_TABLE_DDL = `
CREATE TABLE asset_changes (
  cursor INTEGER NOT NULL PRIMARY KEY,

  asset_id  TEXT REFERENCES assets (id) ON DELETE SET NULL,
  folder_id TEXT REFERENCES folders (id) ON DELETE SET NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('create', 'update', 'delete', 'restore')),

  abs_path      TEXT,
  relative_path TEXT,
  at            TEXT NOT NULL
);
`;

export const ASSET_CHANGES_INDEX_DDL = `
-- listChangesSince: cursor > ? ascending, and highestCursor: cursor
-- descending limit 1. The primary key serves both; these two are the
-- secondary lookups.
CREATE INDEX asset_changes_asset ON asset_changes (asset_id);
CREATE INDEX asset_changes_folder_cursor ON asset_changes (folder_id, cursor);
`;

/**
 * Server-wide singletons: the asset-change cursor counter (`seq`) and the JWT
 * signing secret (`value`), keyed by a string id.
 */
export const SERVER_STATE_TABLE_DDL = `
CREATE TABLE server_state (
  id    TEXT NOT NULL PRIMARY KEY,
  seq   INTEGER,
  value TEXT
) WITHOUT ROWID;
`;

/**
 * Pending file copies to a mirror root. `mirror_path` is the natural key, so
 * re-detection and repeated failures coalesce instead of duplicating.
 */
export const MIRROR_QUEUE_TABLE_DDL = `
CREATE TABLE mirror_queue (
  id INTEGER PRIMARY KEY,

  primary_path TEXT NOT NULL,
  mirror_path  TEXT NOT NULL UNIQUE,
  reason       TEXT NOT NULL CHECK (reason IN ('scan-missing', 'write-failure')),

  -- Claim lease: epoch-ms the current claim expires, or NULL when free.
  claimed_at  INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  dead        INTEGER NOT NULL DEFAULT 0 CHECK (dead IN (0, 1)),
  enqueued_at INTEGER NOT NULL
);
`;

export const MIRROR_QUEUE_INDEX_DDL = `
-- Copy-worker claim: live rows, free or expired lease, oldest first.
CREATE INDEX mirror_queue_claim
  ON mirror_queue (claimed_at, enqueued_at)
  WHERE dead = 0;
`;

/**
 * Quantised lat/lon → reverse-geocoded place, so clustered photos at one
 * location share a single Nominatim call. The quantised key IS the id.
 */
export const GEOCODE_CACHE_TABLE_DDL = `
CREATE TABLE geocode_cache (
  id               TEXT NOT NULL PRIMARY KEY,
  place            TEXT NOT NULL CHECK (json_valid(place)),
  fetched_at       TEXT NOT NULL,
  geocoder_version INTEGER NOT NULL
) WITHOUT ROWID;
`;

export const GEOCODE_CACHE_INDEX_DDL = `
-- Invalidate the cache wholesale when the geocoder version bumps.
CREATE INDEX geocode_cache_version ON geocode_cache (geocoder_version);
`;

/**
 * Named adjustment presets. `fields` and `extra` stay JSON: `fields` is a
 * sparse bag of canonical snake_case adjustment keys, and `extra` exists
 * precisely to preserve keys this server version does not understand, which is
 * the one thing a column would destroy.
 */
export const PRESETS_TABLE_DDL = `
CREATE TABLE presets (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  name           TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  fields         TEXT NOT NULL CHECK (json_valid(fields)),
  extra          TEXT CHECK (extra IS NULL OR json_valid(extra)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
`;

export const PRESETS_INDEX_DDL = `
-- Case-insensitive uniqueness, standing in for the Mongo collation
-- { locale: 'en', strength: 2 } — but only over ASCII, because NOCASE folds
-- A-Z and nothing else. Two presets can still hold the same accented name.
-- people carried the same gap and fixed it with a stored folded key
-- (db/sqlite/case-fold.ts); this one waits for the slice that ports the
-- presets repo, since a NOT NULL key column with no writer is untestable.
-- Tracked by #3781.
CREATE UNIQUE INDEX presets_name_unique ON presets (name COLLATE NOCASE);
`;
