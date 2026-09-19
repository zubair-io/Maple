/**
 * Settings, operational singletons and the audit rows: the collections that
 * are neither the library nor its people, and that no other DDL module owns.
 *
 * Two slices met here. #3743 enumerated the collections `src/api` opens and
 * modelled nine of them from their call sites; #3751 ported six to real
 * repositories and, in doing so, read what the stored documents actually
 * contain. Where the two disagreed the port's shape is the one kept, because
 * it is the one with a repository and tests behind it — `indexer_checkpoints`
 * needs defaults, because an in-flight marker upserts on the folder id alone
 * and creates a row holding nothing else; `video_geo_backfill_audit` names its
 * donor columns the way the writer does. The four the port never touched —
 * `worker_status` and the three Meilisearch backfill tables — keep the
 * schema's version, which is the only one there is.
 *
 * ## Why `app_settings` is one JSON column and nothing else
 *
 * Every other table in this schema follows the rule that a field a query
 * filters on is a column. `app_settings` is the one place that rule does not
 * apply, because nothing ever filters it: all twenty-odd call sites read one
 * document by its id and write a flat `$set` back. The documents themselves
 * have nothing in common — the observability row holds an OTLP endpoint, the
 * describe row holds a model name and a daily spend cap, the migration row
 * holds a map of per-migration enable flags — so columns would mean either one
 * table per settings domain or a wide table of mutually exclusive nullable
 * fields that every new knob has to migrate.
 *
 * A single JSON document per id keeps the storage as boring as the access
 * pattern, and SQLite's `json_set` makes the partial update atomic rather than
 * a read-modify-write: `json_set(doc, '$.migrations.refile.enabled', json(?))`
 * creates the intermediate objects it needs, which is exactly what a dotted
 * Mongo `$set` path did.
 */

/**
 * Operator-tunable configuration, one JSON document per settings domain.
 *
 * The id is the same string the Mongo `_id` held — `enrichment`, `network`,
 * `observability`, `migration`, `missing-reaper` and so on — so a row keeps
 * the name the settings page, the route and the repo module already use.
 */
export const APP_SETTINGS_TABLE_DDL = `
CREATE TABLE app_settings (
  id  TEXT NOT NULL PRIMARY KEY,
  doc TEXT NOT NULL CHECK (json_valid(doc))
) WITHOUT ROWID;
`;

/**
 * Per-library indexer resume point.
 *
 * `path` and `last_walked_at` carry defaults because the in-flight marker
 * upserts on `folder_id` alone: a job claimed before the first full walk
 * finishes creates the row, and on Mongo that row simply had no `path` field.
 * A default is the closest honest equivalent to an absent one.
 */
export const INDEXER_CHECKPOINTS_TABLE_DDL = `
CREATE TABLE indexer_checkpoints (
  folder_id TEXT NOT NULL PRIMARY KEY CHECK (length(folder_id) = 24),

  path           TEXT    NOT NULL DEFAULT '',
  last_walked_at INTEGER NOT NULL DEFAULT 0,
  -- maple:id hex strings picked up but not finished, as a JSON array.
  inflight_ids   TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(inflight_ids)),
  sweep_gen      INTEGER,
  updated_at     INTEGER NOT NULL
) WITHOUT ROWID;
`;

/**
 * ACME account key, issued certificate and in-flight DNS challenges for the
 * managed LAN HTTPS listener. Exactly one row, id `lan`.
 *
 * `lease_until` is a column rather than part of a payload because the lease
 * claim is a conditional `UPDATE … WHERE lease_until <= ?`, which is the whole
 * mechanism that stops two instances renewing the same certificate at once.
 * It defaults to 0 so a freshly inserted row is immediately claimable, the same
 * thing the Mongo version's `$setOnInsert: { lease_until: 0 }` arranged.
 */
export const MANAGED_CERTIFICATES_TABLE_DDL = `
CREATE TABLE managed_certificates (
  id TEXT NOT NULL PRIMARY KEY,

  account_key TEXT,
  -- { hostname, key, cert, not_before, not_after }, read back whole.
  certificate TEXT CHECK (certificate IS NULL OR json_valid(certificate)),
  -- [{ id, zone_id }] — appended to and removed from as challenges resolve.
  challenges  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(challenges)),

  lease_owner        TEXT,
  lease_until        INTEGER NOT NULL DEFAULT 0,
  retry_after        INTEGER,
  attempted_revision TEXT
) WITHOUT ROWID;
`;

/**
 * The daily themed collections the generated-search worker invents.
 *
 * `library_id` is TEXT with no foreign key on purpose: the worker stores the
 * library's hex id as a plain string and compares it as one, and a row whose
 * library has since been unregistered should age out through the retention
 * sweep rather than vanish mid-read.
 *
 * `query` stays JSON because it is a search parameter bag replayed through the
 * same `buildFilter` as `/api/search`; nothing ever filters into it.
 */
export const GENERATED_SEARCHES_TABLE_DDL = `
CREATE TABLE generated_searches (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  library_id    TEXT NOT NULL,
  -- Local day this run targeted, YYYY-MM-DD.
  generated_for TEXT NOT NULL,
  generated_at  TEXT NOT NULL,
  model         TEXT NOT NULL,
  attempts      INTEGER NOT NULL,

  theme    TEXT NOT NULL,
  title    TEXT NOT NULL,
  subtitle TEXT,
  query    TEXT NOT NULL CHECK (json_valid(query)),

  result_count   INTEGER NOT NULL,
  cover_asset_id TEXT
);
`;

export const GENERATED_SEARCHES_INDEX_DDL = `
-- Latest day for a library, then that day's rows: one index serves both.
CREATE INDEX generated_searches_day ON generated_searches (library_id, generated_for DESC);
-- Retention sweep: DELETE WHERE generated_at < cutoff.
CREATE INDEX generated_searches_age ON generated_searches (generated_at);
`;

/**
 * One decision per candidate video for the report-only geo-backfill pass.
 *
 * Keyed by the video's own asset id, which is what makes the pass idempotent —
 * re-running it overwrites a row rather than appending a second verdict, and
 * "how much is left" is the candidate count minus the row count.
 *
 * The donor's coordinates are two columns rather than a JSON pair so the
 * operator review query can range over them without parsing.
 */
export const VIDEO_GEO_BACKFILL_AUDIT_TABLE_DDL = `
CREATE TABLE video_geo_backfill_audit (
  asset_id TEXT NOT NULL PRIMARY KEY CHECK (length(asset_id) = 24),

  maple_id    TEXT,
  captured_at TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('match', 'no-donor', 'skip')),

  donor_id       TEXT,
  donor_maple_id TEXT,
  donor_lat      REAL,
  donor_lng      REAL,
  delta_ms       INTEGER,

  at TEXT NOT NULL
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
