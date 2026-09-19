/**
 * Operational tables: the job runner, imports, the indexer and discover
 * queues, per-stage worker config and handler routing, backup/upload sessions
 * and APNs device tokens.
 *
 * These are queues and configuration, not the photo library, so the schema
 * rule that applies is a different one: claim queries need real columns for
 * their lease and status fields, and everything else can stay a payload. A
 * `jobs` row is read whole by exactly one worker at a time.
 *
 * `job.id`, `import.id` and `upload_session.id` all reach clients through
 * polling endpoints, so they keep the 24-character hex shape.
 */

export const JOBS_TABLE_DDL = `
CREATE TABLE jobs (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  kind   TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),

  -- Claim lease, mirroring the geocode worker's.
  locked_by        TEXT,
  lease_expires_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),

  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total   INTEGER NOT NULL DEFAULT 0,
  error            TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  -- Kind-specific request, result and recovery ledger. Every handler reads its
  -- own whole; none of it is ever filtered on.
  params  TEXT CHECK (params IS NULL OR json_valid(params)),
  result  TEXT CHECK (result IS NULL OR json_valid(result)),
  ledger  TEXT CHECK (ledger IS NULL OR json_valid(ledger)),
  -- Library roots locked while a selected settings batch is active.
  batch_scopes TEXT CHECK (batch_scopes IS NULL OR json_valid(batch_scopes))
);
`;

export const JOBS_INDEX_DDL = `
CREATE INDEX jobs_claim ON jobs (status, lease_expires_at);
CREATE INDEX jobs_list  ON jobs (kind, status, created_at DESC);
`;

export const IMPORTS_TABLE_DDL = `
CREATE TABLE imports (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),

  source_root  TEXT NOT NULL,
  library_id   TEXT NOT NULL REFERENCES folders (id),
  library_root TEXT NOT NULL,

  -- Auto Import: the worker scans source_root itself when it claims the job.
  scan_pending INTEGER NOT NULL DEFAULT 0 CHECK (scan_pending IN (0, 1)),

  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total   INTEGER NOT NULL DEFAULT 0,
  count_copied     INTEGER NOT NULL DEFAULT 0,
  count_skipped    INTEGER NOT NULL DEFAULT 0,
  count_failed     INTEGER NOT NULL DEFAULT 0,

  error            TEXT,
  locked_by        TEXT,
  lease_expires_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const IMPORTS_INDEX_DDL = `
CREATE INDEX imports_claim ON imports (status, lease_expires_at);
CREATE INDEX imports_list  ON imports (status, created_at DESC);
`;

/**
 * One row per file in an import. This table was already a separate collection
 * on Mongo, because an inline array of tens of thousands of entries blew past
 * the 16 MiB document ceiling mid-scan. Rows have no such ceiling, so the split
 * simply stays.
 */
export const IMPORT_FILES_TABLE_DDL = `
CREATE TABLE import_files (
  id INTEGER PRIMARY KEY,

  import_id TEXT NOT NULL REFERENCES imports (id) ON DELETE CASCADE,
  -- Stable 0-based position, so the worker can pull files in deterministic
  -- order and update one row's progress without rewriting the set.
  idx       INTEGER NOT NULL,

  src      TEXT NOT NULL,
  dest     TEXT NOT NULL,
  size     INTEGER NOT NULL,
  mtime    INTEGER NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('image', 'sidecar', 'movie')),
  state    TEXT NOT NULL CHECK (state IN ('pending', 'copied', 'skipped_duplicate', 'failed')),
  error    TEXT,

  UNIQUE (import_id, idx)
);
`;

export const INDEXER_QUEUE_TABLE_DDL = `
CREATE TABLE indexer_queue (
  id INTEGER PRIMARY KEY,

  kind    TEXT NOT NULL CHECK (kind IN ('scan_folder', 'gen_thumb', 'extract_exif')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  status  TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  error   TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const INDEXER_QUEUE_INDEX_DDL = `
CREATE INDEX indexer_queue_status ON indexer_queue (status);
`;

/**
 * One directory still to visit in an in-progress discover sweep. The frontier
 * is on disk rather than the heap so a walk's memory is O(one directory).
 */
export const DISCOVER_FRONTIER_TABLE_DDL = `
CREATE TABLE discover_frontier (
  id INTEGER PRIMARY KEY,

  folder_id  TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  dir_path   TEXT NOT NULL,
  sweep_gen  INTEGER NOT NULL,
  -- Lease in epoch-ms so a crashed sweeper's directory is retaken. NULL = free.
  claimed_at  INTEGER,
  enqueued_at INTEGER NOT NULL,
  -- An ancestor directory carries a folder-level '.hidden' marker (#2972).
  hidden_ancestor INTEGER NOT NULL DEFAULT 0 CHECK (hidden_ancestor IN (0, 1)),

  UNIQUE (folder_id, dir_path, sweep_gen)
);
`;

export const DISCOVER_FRONTIER_INDEX_DDL = `
CREATE INDEX discover_frontier_claim
  ON discover_frontier (folder_id, sweep_gen, claimed_at, enqueued_at);
`;

/**
 * Per-stage operator configuration — the DB-backed settings surfaced on
 * Settings → Workers. The AI routing fields are columns because the settings
 * page writes them individually.
 *
 * Every configurable field is nullable, which is the shape the repository
 * actually writes rather than the shape `WorkerConfig` declares.
 * `WorkerConfigRepo.patch` upserts a *partial* config:
 * `registerPausableWorker` (`workers/pause-control.ts`) persists `{ paused }`
 * and nothing else, against a row that need not exist yet, so a row routinely
 * holds a name and one field. The four fields TypeScript marks required are
 * required of a merged, *loaded* config — `bootConfig` substitutes the stage's
 * own default for each one it does not find — not of the stored row, and
 * `NOT NULL` columns turn that first partial write into a constraint failure.
 *
 * `paused` is the subtler half of the same point. A defaulted `false` is
 * indistinguishable from an operator resume, so a row created by a
 * `{ concurrency }` patch would tell `bootConfig` the stage is running and
 * suppress `pausedOnFirstBoot` — the flag `geocode` uses to stay parked until
 * an operator has configured it. Absent has to stay distinguishable from
 * false, which in SQL means NULL.
 *
 * `sweep_dir_interval_ms` is the discover worker's own knob. `discover` is not
 * a stage; it shares this table under `name = 'discover'` and stores one field
 * beside `paused` (`workers/discover/discover-config.repo.ts`). One nullable
 * column rather than a JSON side-bag, because there is exactly one such field
 * and a bag would be a schema built for a second caller that does not exist.
 */
export const WORKER_CONFIG_TABLE_DDL = `
CREATE TABLE worker_config (
  name TEXT NOT NULL PRIMARY KEY,

  -- NULL means "no operator or boot has set this", which is what an absent
  -- field meant on the document. Every reader has a default to fall back to.
  concurrency  INTEGER,
  max_attempts INTEGER,
  paused       INTEGER CHECK (paused IS NULL OR paused IN (0, 1)),
  -- Why the stage paused ITSELF; NULL for an operator pause.
  pause_reason TEXT,

  last_seen_target_version INTEGER,

  version     TEXT,
  prompt_text TEXT,
  ai_provider TEXT,
  ai_model    TEXT,

  -- The discover worker's row only: gap between directory visits in a sweep.
  sweep_dir_interval_ms INTEGER
) WITHOUT ROWID;
`;

export const STAGE_HANDLERS_TABLE_DDL = `
CREATE TABLE stage_handlers (
  stage      TEXT NOT NULL PRIMARY KEY,
  impl       TEXT NOT NULL CHECK (impl IN ('builtin', 'http')),
  url        TEXT,
  timeout_ms INTEGER,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
) WITHOUT ROWID;
`;

/** Per-device, per-library cumulative backup progress. Never pruned. */
export const BACKUP_SESSIONS_TABLE_DDL = `
CREATE TABLE backup_sessions (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  library_id TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL,

  started_at       TEXT NOT NULL,
  last_progress_at TEXT NOT NULL,
  total_count      INTEGER NOT NULL DEFAULT 0,
  uploaded_count   INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,

  -- Natural key: what makes the progress upsert race-safe.
  UNIQUE (library_id, device_id)
);
`;

/**
 * One in-flight or resumable chunked upload.
 *
 * `expires_at` replaces the Mongo TTL index. SQLite has no TTL monitor, so the
 * rows every TTL index used to sweep are swept by an explicit periodic DELETE
 * instead; the column and its index are what make that DELETE a range scan.
 */
export const UPLOAD_SESSIONS_TABLE_DDL = `
CREATE TABLE upload_sessions (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  library_id       TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  device_id        TEXT NOT NULL,
  phasset_local_id TEXT NOT NULL,
  phasset_cloud_id TEXT,

  -- Device-computed target, kept verbatim so a retry short-circuits even when
  -- the bytes actually landed at a disambiguated sibling.
  target_rel_path   TEXT NOT NULL,
  resolved_rel_path TEXT,

  total_bytes    INTEGER NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  chunk_size     INTEGER NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('open', 'completed', 'abandoned')),
  maple_id       TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,

  -- Resume key: unique per asset per device per library.
  UNIQUE (library_id, device_id, phasset_local_id)
);
`;

export const UPLOAD_SESSIONS_INDEX_DDL = `
-- Cross-device conflict probe: another device actively uploading the same
-- iCloud photo.
CREATE INDEX upload_sessions_cloud_id
  ON upload_sessions (library_id, phasset_cloud_id)
  WHERE state = 'open' AND phasset_cloud_id IS NOT NULL;

-- Expiry sweep (replaces the 7-day TTL index).
CREATE INDEX upload_sessions_expiry ON upload_sessions (expires_at);
`;

/** One row per (user, device) wanting File Provider push-to-signal wake-ups. */
export const APNS_DEVICE_TOKENS_TABLE_DDL = `
CREATE TABLE apns_device_tokens (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_token TEXT NOT NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('ios', 'macos')),
  environment  TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  -- Re-registering the same pair upserts rather than duplicating.
  UNIQUE (user_id, device_token)
);
`;

export const APNS_DEVICE_TOKENS_INDEX_DDL = `
CREATE INDEX apns_device_tokens_token ON apns_device_tokens (device_token);
`;
