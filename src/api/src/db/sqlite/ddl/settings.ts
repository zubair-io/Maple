/**
 * Settings, server-side singletons and the worker bookkeeping that belongs to
 * no single queue: `app_settings`, `worker_status`, `indexer_checkpoints`,
 * `managed_certificates`, `generated_searches`, `video_geo_backfill_audit` and
 * the three `meilisearch_backfill_*` collections.
 *
 * These are the nine collections the first draft of this schema left out. None
 * of them is on the hot path — most are one row — but leaving them undeclared
 * would have meant the table list read as complete while the settings system
 * CLAUDE.md mandates had nowhere to live.
 *
 * Two shape rules are worth stating, because they differ from the asset side:
 *
 *  1. **A settings document stays a document.** `app_settings` is read by id
 *     and written back with `$set`; nothing filters on a field inside it, and
 *     the sixteen documents have almost nothing in common. Columns would buy
 *     nothing and would have to be migrated every time a config gains a knob.
 *  2. **A singleton says so in a CHECK.** `worker_status`, the Meilisearch
 *     backfill state and its lease are one row by construction, so the id is
 *     pinned to the literal the code uses. A second row is a bug, and the
 *     constraint is where that gets caught.
 */

/**
 * Every DB-backed setting, one JSON document per domain, keyed by the same
 * string id the Mongo `_id` carries: `enrichment`, `cloudflare`, `map`,
 * `network`, `managed_https`, `apns`, `render`, `pano`, `observability`,
 * `performance`, `display`, `deduplicate`, `derivative-audit`,
 * `generated_search`, `migration`, `missing-reaper`.
 *
 * This is the table behind the settings pages, which is where Maple's
 * operator-toggleable configuration lives by policy rather than by accident —
 * a DB-backed setting is changeable at runtime and visible in the UI, where an
 * environment variable is neither.
 *
 * `doc` is the whole document minus its id. Eleven of the sixteen are already
 * shaped `{ _id, config: {...} }` and the rest are a flat bag of optional
 * fields; every call site is `findOne({ _id })` plus an upsert of a `$set`,
 * with `json_set` covering the one partial-update case (`migration`'s
 * per-migration sub-keys). Nothing queries this table by anything but its id,
 * so it has no secondary index and needs none.
 */
export const APP_SETTINGS_TABLE_DDL = `
CREATE TABLE app_settings (
  id  TEXT NOT NULL PRIMARY KEY,
  doc TEXT NOT NULL CHECK (json_valid(doc))
) WITHOUT ROWID;
`;

/**
 * The Settings → Workers status row: what every stage is doing, plus the
 * periodically recomputed progress counters (#3491).
 *
 * One row, written by the worker process every couple of seconds and read by
 * `/api/workers/status`. `counts_wanted_until` is the demand flag the route
 * raises so the worker knows a human is watching and the expensive counts are
 * worth computing; it is written with `$max` rather than `$set`, which in SQL
 * is `MAX(existing, excluded)` in the upsert's DO UPDATE clause — a shorter
 * deadline must never shorten a longer one already in flight.
 */
export const WORKER_STATUS_TABLE_DDL = `
CREATE TABLE worker_status (
  id TEXT NOT NULL PRIMARY KEY CHECK (id = 'singleton'),

  -- Per-stage snapshot, keyed by stage name.
  statuses    TEXT NOT NULL CHECK (json_valid(statuses)),
  -- Face-model load state: { kind, errorDetail }.
  face_models TEXT CHECK (face_models IS NULL OR json_valid(face_models)),
  -- Epoch ms of the last write, as the status route reports it.
  updated_at  INTEGER NOT NULL,

  -- Pending / ready / dead per stage, plus the damaged and newly-hidden
  -- badges, and what computing them cost.
  counts              TEXT CHECK (counts IS NULL OR json_valid(counts)),
  counts_wanted_until INTEGER
) WITHOUT ROWID;
`;

/**
 * Where the discover sweeper left off in one library root.
 *
 * `folder_id` is the key — the Mongo collection carries a generated `_id` that
 * nothing ever reads and a `folderId` that every query uses, with a unique
 * index declared on it by a function that is never called. Here the real key
 * is the primary key and the accidental one is gone.
 *
 * The foreign key cascades, unlike the one on `asset_changes`: a checkpoint is
 * a pointer to a live library root rather than a record of something that
 * happened, so when the root is deregistered its resume position is garbage.
 */
export const INDEXER_CHECKPOINTS_TABLE_DDL = `
CREATE TABLE indexer_checkpoints (
  folder_id TEXT NOT NULL PRIMARY KEY REFERENCES folders (id) ON DELETE CASCADE,

  -- Absolute path walked, denormalised from the folder for log readability.
  path            TEXT    NOT NULL,
  -- Epoch ms of the last completed full walk.
  last_walked_at  INTEGER NOT NULL,
  -- maple ids picked up by a sweep and not yet finished. Written whole by the
  -- sweeper on every checkpoint, never filtered into.
  inflight_ids    TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(inflight_ids)),
  -- Generation of the discover sweep currently in flight.
  sweep_gen       INTEGER,
  updated_at      INTEGER NOT NULL
) WITHOUT ROWID;
`;

/**
 * The ACME account key and the issued LAN certificate, plus the lease that
 * stops two processes renewing at once.
 *
 * One row, id `lan`. `lease_owner` and `lease_until` are columns rather than
 * payload because they are the compare-and-swap predicate: claiming is an
 * `UPDATE … WHERE id = 'lan' AND lease_until <= ?` whose row count decides the
 * winner, and renewing and releasing both carry `AND lease_owner = ?`.
 */
export const MANAGED_CERTIFICATES_TABLE_DDL = `
CREATE TABLE managed_certificates (
  id TEXT NOT NULL PRIMARY KEY,

  -- ACME account key (PEM).
  account_key TEXT,
  -- { hostname, key, cert, not_before, not_after }, read whole by the HTTPS
  -- listener when it loads the certificate.
  certificate TEXT CHECK (certificate IS NULL OR json_valid(certificate)),
  -- In-flight DNS-01 records: [{ id, zone_id }], added and removed whole.
  challenges  TEXT CHECK (challenges IS NULL OR json_valid(challenges)),

  -- Renewal lease. Epoch ms, 0 when free.
  lease_owner       TEXT,
  lease_until       INTEGER NOT NULL DEFAULT 0,
  -- Epoch ms before which a failed issuance must not be retried.
  retry_after       INTEGER,
  attempted_revision TEXT
) WITHOUT ROWID;
`;

/**
 * The generated-search worker's output: one saved collection per theme per
 * day, per library.
 *
 * The id reaches clients — `/api/generated-searches/:id` looks a row up by it
 * — so it keeps the 24-character hex shape.
 */
export const GENERATED_SEARCHES_TABLE_DDL = `
CREATE TABLE generated_searches (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  library_id    TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  -- Local day this collection was generated for, as YYYY-MM-DD.
  generated_for TEXT NOT NULL,
  -- ISO 8601 write time. Retention and the "themes used recently" prompt
  -- digest both range over this.
  generated_at  TEXT NOT NULL,

  model    TEXT    NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,

  theme    TEXT NOT NULL,
  title    TEXT NOT NULL,
  subtitle TEXT,

  -- The saved search itself: { placeQuery?, from?, to?, month?, people?,
  -- sceneType? }. Replayed against the search route as a whole; no field of it
  -- is ever a predicate here.
  query TEXT NOT NULL CHECK (json_valid(query)),

  result_count   INTEGER NOT NULL DEFAULT 0,
  cover_asset_id TEXT
);
`;

export const GENERATED_SEARCHES_INDEX_DDL = `
-- "Latest day generated for this library", and then that day's rows.
CREATE INDEX generated_searches_library_day
  ON generated_searches (library_id, generated_for DESC);

-- Retention sweep (generated_at < cutoff) and the recent-themes digest.
CREATE INDEX generated_searches_generated_at
  ON generated_searches (generated_at);
`;

/**
 * One decision per video from the apply-video-geo-backfill pass: whether a
 * donor photo's GPS was borrowed, and from which one.
 *
 * `asset_id` is the key, reused from the audited asset so a re-run overwrites
 * its own row instead of appending a second opinion. It carries no foreign
 * key, for the same reason `asset_changes` carries none: this is a record that
 * a decision was taken about an id at a point in time, not a pointer to a live
 * row, and it has to survive the asset it describes.
 */
export const VIDEO_GEO_BACKFILL_AUDIT_TABLE_DDL = `
CREATE TABLE video_geo_backfill_audit (
  asset_id TEXT NOT NULL PRIMARY KEY,

  maple_id    TEXT,
  -- ISO capture time of the audited video; empty for a 'skip'.
  captured_at TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('match', 'no-donor', 'skip')),

  -- The donor photo, when one was found.
  donor_id        TEXT,
  donor_maple_id  TEXT,
  donor_gps_lat   REAL,
  donor_gps_lng   REAL,
  -- Signed milliseconds between the two capture times.
  delta_ms        INTEGER,

  at TEXT NOT NULL
) WITHOUT ROWID;
`;

/**
 * Resume state for the Meilisearch backfill: where the cursor reached and what
 * it has done since it started.
 *
 * One row, id `assets`. The five counters are incremented per batch (`$inc` on
 * Mongo, `counter = counter + ?` here), which is why they are columns with a
 * NOT NULL default rather than a JSON blob — an increment against a missing
 * key has to mean zero.
 */
export const MEILISEARCH_BACKFILL_STATE_TABLE_DDL = `
CREATE TABLE meilisearch_backfill_state (
  id TEXT NOT NULL PRIMARY KEY CHECK (id = 'assets'),

  -- Durable resume position: the asset id the last batch reached, or NULL
  -- before the first batch.
  cursor TEXT,

  scanned     INTEGER NOT NULL DEFAULT 0,
  upserted    INTEGER NOT NULL DEFAULT 0,
  tombstoned  INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0,
  remaining   INTEGER,

  -- Retry bookkeeping for a backfill blocked on a Meilisearch that is down.
  retry_attempts INTEGER NOT NULL DEFAULT 0,
  retry_error    TEXT,
  blocked_at     TEXT,

  started_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT,

  -- ASSET_DOC_SHAPE_VERSION this generation was written for. A row written for
  -- an older shape is deleted and restarted rather than resumed.
  doc_shape_version INTEGER
) WITHOUT ROWID;
`;

/**
 * The backfill's single-runner lease. One row, id `assets`, deleted on
 * release.
 *
 * `expires_at` is epoch ms rather than the ISO string the rest of the schema
 * uses, matching the other leases in this database (`mirror_queue.claimed_at`,
 * `managed_certificates.lease_until`): a lease is arithmetic on a clock, not a
 * timestamp anyone reads.
 */
export const MEILISEARCH_BACKFILL_LEASES_TABLE_DDL = `
CREATE TABLE meilisearch_backfill_leases (
  id TEXT NOT NULL PRIMARY KEY CHECK (id = 'assets'),

  owner      TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
`;

/**
 * Assets the backfill could not index, keyed by asset id so a repeat failure
 * increments `attempts` on the same row.
 *
 * This one does carry a cascading foreign key, where the video-geo audit above
 * does not: it is a work list rather than a record. Its only consumer is the
 * redrive pass, which re-reads each asset and tries again, so a row whose
 * asset is gone is not history — it is a unit of work that can never succeed.
 */
export const MEILISEARCH_BACKFILL_FAILURES_TABLE_DDL = `
CREATE TABLE meilisearch_backfill_failures (
  asset_id TEXT NOT NULL PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,

  maple_id   TEXT NOT NULL,
  -- Bounded error message from the failing upsert.
  error      TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
`;

export const MEILISEARCH_BACKFILL_FAILURES_INDEX_DDL = `
-- The redrive pass takes the oldest failures first, and that ordering is what
-- makes it terminate: a row it retries and fails again is rewritten with a new
-- updated_at, so it goes to the back of the queue.
CREATE INDEX meilisearch_backfill_failures_oldest
  ON meilisearch_backfill_failures (updated_at);
`;
