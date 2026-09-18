/**
 * `stage_state` — the per-asset, per-stage pipeline bookkeeping that lives
 * under `stages.<name>` on the Mongo document today.
 *
 * ## What this replaces
 *
 * Every registered stage gets two indexes on `assets`: `stage_<name>_version`
 * on `stages.<name>.version`, and `stage_<name>_dead`, a partial index on
 * `stages.<name>.dead`. With 12 stages in `ALL_STAGE_NAMES` that is 24 of the
 * 50 named indexes on the collection, and registering a thirteenth stage means
 * writing two more index definitions and rebuilding them on the next boot.
 * Production carries more than 24 because indexes for retired stages were never
 * dropped.
 *
 * Here the stage name is data, so the whole set collapses to two indexes that
 * do not grow: one for the claim scan and one for the dead-letter list.
 * Registering a stage becomes an insert.
 *
 * ## Shape
 *
 * `(asset_id, stage)` is the key, and the table is `WITHOUT ROWID` so the row
 * lives in the primary-key B-tree itself — one lookup to reach a stage's state
 * for an asset, and no duplicate copy of the key in a separate index.
 *
 * A missing row means "never run", which is what `version = 0` means today.
 * The claim query therefore has to consider assets with no row for the stage
 * at all; that is a `LEFT JOIN … WHERE stage_state.asset_id IS NULL OR
 * stage_state.version < ?`, and it is the reason `stage_claim` leads with
 * `stage` rather than `version`.
 */

export const STAGE_STATE_TABLE_DDL = `
CREATE TABLE stage_state (
  asset_id  TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  -- Free-form: registering a new stage is an insert, not a schema change.
  stage     TEXT NOT NULL,

  -- Handler version this asset was last processed at. Below the stage's
  -- targetVersion means "claimable".
  version          INTEGER NOT NULL DEFAULT 0,
  -- Failed attempts at the current target version. Reset on success or bump.
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  -- Wall clock of the most recent successful run.
  processed_at     TEXT,
  -- attempts >= maxAttempts. Excluded from the claim query, listed by the
  -- dead-letter triage UI.
  dead             INTEGER NOT NULL DEFAULT 0 CHECK (dead IN (0, 1)),
  -- Most recent FAILED attempt, so last_error has a "when" (#2730).
  failed_at        TEXT,
  -- Backoff floor: the earliest this asset may be re-claimed (#2729). NULL
  -- means claimable now, which is how every pre-existing row reads.
  next_attempt_at  TEXT,

  PRIMARY KEY (asset_id, stage)
) WITHOUT ROWID;
`;

export const STAGE_STATE_INDEX_DDL = `
-- The claim scan. Leading 'stage' selects the one stage's rows; 'version'
-- then orders the below-target candidates; 'dead' and 'next_attempt_at' are
-- the two gates the claim query applies, both covered here so the scan never
-- reads a stage_state row body.
CREATE INDEX stage_claim
  ON stage_state (stage, version, dead, next_attempt_at, asset_id);

-- Dead-letter list and its per-stage count on Settings -> Workers. Partial, so
-- the index holds only the parked rows — the equivalent of the 12 separate
-- stage_<name>_dead partial indexes, as one.
CREATE INDEX stage_dead
  ON stage_state (stage, asset_id)
  WHERE dead = 1;
`;

/**
 * `enrichment_state` — the older per-stage bookkeeping under `enrichment.*`.
 *
 * Deliberately a second table rather than extra columns on `stage_state`: the
 * two are different state machines over the same three names. `stages.geocode`
 * is the live worker-runner's row (version / dead / backoff) while
 * `enrichment.geocode` is the Phase-2 lease-based claim (`done_at`,
 * `locked_by`, `lease_expires_at`, `dead_letter_at`). Folding them together
 * would mean one row meaning two things for `geocode`, `face` and `describe`.
 *
 * It also gets the index the Mongo version never had: the admin dead-letter
 * list (`listEnrichmentDeadLetter`) filters `enrichment.<stage>.dead_letter_at
 * != null` and sorts on it descending, which is a full collection scan today.
 */
export const ENRICHMENT_STATE_TABLE_DDL = `
CREATE TABLE enrichment_state (
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  stage    TEXT NOT NULL CHECK (stage IN ('geocode', 'face', 'describe')),

  done_at          TEXT,
  locked_by        TEXT,
  lease_expires_at TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  version          INTEGER,
  dead_letter_at   TEXT,

  PRIMARY KEY (asset_id, stage)
) WITHOUT ROWID;
`;

export const ENRICHMENT_STATE_INDEX_DDL = `
-- Lease-based claim: unfinished rows for one stage, free or expired lease.
CREATE INDEX enrichment_claim
  ON enrichment_state (stage, done_at, lease_expires_at)
  WHERE done_at IS NULL;

-- Admin dead-letter triage, newest first. New index — the Mongo query behind
-- it scans the whole collection.
CREATE INDEX enrichment_dead_letter
  ON enrichment_state (stage, dead_letter_at DESC)
  WHERE dead_letter_at IS NOT NULL;
`;
