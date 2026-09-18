/**
 * The tables the initial schema (#3743) did not model, added by migration
 * `0002` for the remaining-collections port (#3751).
 *
 * Four of them are collections the schema slice simply did not enumerate —
 * `app_settings`, `indexer_checkpoints`, `managed_certificates`,
 * `generated_searches` and `video_geo_backfill_audit`. The fifth entry here is
 * a correction: `image_access_tokens` was modelled from the collection's name
 * rather than from the document the code actually writes, and the two do not
 * line up (see {@link IMAGE_ACCESS_TOKENS_REBUILD_DDL}).
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
 * Rebuild of `image_access_tokens` to match the document the code writes.
 *
 * The initial schema gave this table a 24-character hex primary key, a
 * `token_hash` column and a `user_id` foreign key. The capability the
 * application actually stores has none of those: its `_id` **is** the
 * SHA-256 hex of the token (64 characters), it carries the exact `path` the
 * grant is bound to and a `purpose` discriminator, and it names no user —
 * the whole point of a capability is that it authorises one URL rather than
 * one principal. A row of the shipped shape could not satisfy
 * `auth/image-capability.ts`'s lookup at all, so this is a correction, not a
 * redesign.
 *
 * Dropping rather than altering is safe and is the honest thing to do:
 * `length(id) = 24` and `user_id NOT NULL` cannot be relaxed by `ALTER TABLE`,
 * no code path in the repository issues one of these grants today, and the
 * table is short-lived by construction — every row expires within minutes, so
 * even a populated one loses nothing that would still be valid.
 */
export const IMAGE_ACCESS_TOKENS_REBUILD_DDL = `
DROP TABLE image_access_tokens;

CREATE TABLE image_access_tokens (
  -- SHA-256 hex of the opaque URL token. The token itself is never stored.
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 64),

  -- The one request path this grant authorises, compared exactly.
  path    TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('image-read')),

  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) WITHOUT ROWID;

-- Expiry sweep (replaces the TTL index), same shape as the other five.
CREATE INDEX image_access_tokens_expiry ON image_access_tokens (expires_at);
`;
