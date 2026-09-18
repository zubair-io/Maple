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
 *
 * `asset_id` and `folder_id` carry no foreign key, and that is the one thing
 * about this table worth arguing over. It is a journal of things that happened,
 * not a set of live relationships: the single most important row in it is a
 * `delete`, written by `routes/assets/trash.ts` *after* `hardDelete` has already
 * removed the asset. A foreign key would reject that insert outright, and
 * `ON DELETE SET NULL` would blank the id of any delete row that did land —
 * either way the File Provider extension never learns which item to drop, and
 * the change repository's best-effort error handling would swallow the failure
 * silently. The same argument applies to a library that gets deregistered while
 * a client is mid-sync. Referential integrity here would destroy exactly the
 * events the feed exists to deliver.
 *
 * The keys were here when `0001-initial-schema` shipped, so removing them from
 * this constant is only half the change: the migration runner skips a recorded
 * id without looking at what it declares, and a database already at 0001 would
 * keep them forever. `migrations/0002-asset-changes-no-foreign-keys.ts` is the
 * other half, and rebuilds the table on any database that still carries them.
 */
export const ASSET_CHANGES_TABLE_DDL = `
CREATE TABLE asset_changes (
  cursor INTEGER NOT NULL PRIMARY KEY,

  asset_id  TEXT,
  folder_id TEXT,
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
-- Case-insensitive uniqueness, matching the Mongo collation
-- { locale: 'en', strength: 2 }.
CREATE UNIQUE INDEX presets_name_unique ON presets (name COLLATE NOCASE);
`;
