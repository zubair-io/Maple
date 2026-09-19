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
 * ## Rows are dense, and that is deliberate
 *
 * Every asset gets one row per registered stage, seeded at `version = 0`, at
 * the moment the asset is created. On Mongo a missing `stages.<name>` subdoc is
 * claimable because BSON orders a missing field below any number, so
 * `{ version: { $lt: target } }` matches it; the SQL equivalent of that is an
 * anti-join against `assets`, which cannot use an index on `stage_state` at
 * all.
 *
 * Seeding instead makes the claim a plain index range scan — measured at
 * 0.05 ms for 500 candidates over 12 million rows. The cost is the rows
 * themselves, and it is worth it: the same 12 million rows carry every stage,
 * where Mongo needed two dedicated indexes per stage over the whole asset
 * collection.
 *
 * Registering a thirteenth stage is then one statement — `INSERT INTO
 * stage_state (asset_id, stage) SELECT id, 'new-stage' FROM assets` — instead
 * of two index definitions and a rebuild on the next boot. That is what the
 * ticket means by "a data insert".
 *
 * The cost of dense rows is that a stage which applies to a subset of assets
 * has a backlog the size of the library, and the scan above is as long as the
 * backlog. {@link STAGE_STATE_MEDIA_KIND_DDL} is how the two stages in that
 * position get the subset into the index instead of into a filter (#3795).
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
 * `stage_state.media_kind` — the asset's media kind, denormalised onto the
 * stage row so that a stage which only applies to video or audio can be
 * narrowed by an index instead of by a filter (#3795).
 *
 * ## The bug this fixes
 *
 * `transcribe` and `video-describe` apply to 15,790 of the owner's 335,419
 * assets. They expressed that as an `EXISTS` over `assets` evaluated per
 * candidate row, which the claim could only apply AFTER {@link
 * STAGE_STATE_INDEX_DDL}'s scan had produced the candidate. `version < target`
 * is an index range, so the scan's length is the stage's backlog — and for
 * these two stages the backlog is the whole photo library, 323,398 rows that
 * can never match. Once the stage had caught up on the media it CAN claim,
 * every poll tick walked all of them and found nothing: 420 ms of CPU per tick
 * per stage, continuously, which on a two-reader pool queued every other read
 * behind it until requests timed out at 30 seconds.
 *
 * On MongoDB the same backlog existed and cost nothing, because the stage
 * version and the media kind sat on one document and could be combined into a
 * single indexed query. This column restores that: the narrowing happens in the
 * index, before the scan, not in a filter after it.
 *
 * ## Owned by triggers, like `live_location_count`
 *
 * No writer sets this column. {@link STAGE_STATE_MEDIA_KIND_TRIGGER_DDL} fills
 * it from `assets` when a stage row is inserted and re-stamps every stage row
 * for an asset whose kind changes — which it does, because `media_kind` is
 * itself derived from the asset's locations and is recomputed whenever they
 * change (a photo that gains a video location, a backup merge). A call site
 * that forgets to maintain a denormalised column is how #2177 happened; a
 * trigger cannot forget, and it is the same mechanism `assets.live_location_count`
 * already uses for the same reason.
 *
 * ## It narrows; `assets` still decides
 *
 * The claim residual keeps its `EXISTS` over `assets` as the authoritative
 * test and merely AND-s {@link STAGE_STATE_MEDIA_NARROWING} in front of it, so
 * the set of assets a stage claims is provably the set it claimed before. The
 * column's only job is to select the partial index below.
 *
 * `DEFAULT 'image'` makes the `ALTER TABLE` a metadata-only change on a table
 * with 4.9 million rows; migration `0002` then backfills the minority kinds and
 * the triggers keep it true from there.
 */
export const STAGE_STATE_MEDIA_KIND_DDL = `
ALTER TABLE stage_state ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'image';

-- The claim scan for a stage that only applies to video or audio. The same
-- columns in the same order as stage_claim, so the scan, the ORDER BY and the
-- gates all behave identically — it just holds 4.7% of the rows. Partial over
-- exactly the two minority kinds, mirroring assets_media_kind_av (#3492), and
-- spelled the way the residual spells it, because SQLite only uses a partial
-- index when the query's WHERE provably implies the index's.
--
-- media_kind is repeated as a trailing column although the partial WHERE
-- already implies it, so a stage narrower than the index — video-describe takes
-- video and not audio — can reject the rest without also probing assets for
-- each one: 8.5 ms a tick against 19 ms, measured at production shape.
--
-- Trailing rather than in front of the version column, measured both ways.
-- In front, the kind becomes a seek and video-describe drops to 0.002 ms — but
-- transcribe's two kinds are then an IN over the second column, the ORDER BY
-- stops being the index's own order, and its claim rises to 10.9 ms whenever it
-- has a backlog. Trailing is the better worst case and it is the one that keeps
-- the no-sort property the claim has always had.
CREATE INDEX stage_claim_media
  ON stage_state (stage, version, dead, next_attempt_at, asset_id, media_kind)
  WHERE media_kind IN ('video', 'audio');
`;

/**
 * The narrowing term a media-only stage's claim residual leads with.
 *
 * Imported rather than retyped at the two call sites, for the reason
 * `LIVE_ASSET_PREDICATE` is: SQLite's partial-index implication test is textual
 * enough that a paraphrase — `<> 'image'`, or the two kinds in the other order
 * — silently loses `stage_claim_media` and puts the full-library scan back.
 * `stage_claim.query-plan.test.ts` pins that it does not.
 *
 * Qualified by table name because the residual is spliced into both the
 * candidate `SELECT` and the claim's own `UPDATE`.
 */
export const STAGE_STATE_MEDIA_NARROWING = `stage_state.media_kind IN ('video', 'audio')`;

/**
 * The same, for a stage that takes video and not audio.
 *
 * Both terms are needed and neither is redundant. The `IN` is what makes the
 * index usable at all — SQLite will not infer it from the equality, which is
 * the same thing `assets.migrations.ts` spells out for `assets_media_kind_av`
 * — and the equality is what rejects the audio rows the index still holds,
 * from the index entry rather than after two keyed probes into `assets`.
 * Dropping the equality costs `video-describe` 19 ms a tick instead of 8.5 at
 * production shape; dropping the `IN` costs it the index and puts the whole
 * outage back.
 */
export const STAGE_STATE_VIDEO_NARROWING = `${STAGE_STATE_MEDIA_NARROWING} AND stage_state.media_kind = 'video'`;

/**
 * Keeps `stage_state.media_kind` in step with `assets.media_kind`.
 *
 * Exported apart from the rest of the DDL so a bulk load can drop them, run
 * {@link STAGE_STATE_MEDIA_KIND_RECOMPUTE_SQL} once and put them back — the
 * same trade the location-count triggers make.
 *
 * The insert trigger is guarded by a `WHEN`, so the common case (an image
 * asset, whose seeded row already reads `'image'`) costs one keyed lookup and
 * no write. The update trigger is narrowed with `UPDATE OF media_kind` and
 * fires at most a dozen row updates, one per registered stage.
 */
export const STAGE_STATE_MEDIA_KIND_TRIGGER_DDL = `
CREATE TRIGGER stage_state_media_kind_ai AFTER INSERT ON stage_state
WHEN NEW.media_kind IS NOT (SELECT media_kind FROM assets WHERE id = NEW.asset_id)
BEGIN
  UPDATE stage_state
     SET media_kind = (SELECT media_kind FROM assets WHERE id = NEW.asset_id)
   WHERE asset_id = NEW.asset_id AND stage = NEW.stage;
END;

CREATE TRIGGER assets_media_kind_stage_state_au AFTER UPDATE OF media_kind ON assets
WHEN NEW.media_kind IS NOT OLD.media_kind
BEGIN
  UPDATE stage_state SET media_kind = NEW.media_kind WHERE asset_id = NEW.id;
END;
`;

/** Names of the triggers above, so a bulk load can drop them by name. */
export const STAGE_STATE_MEDIA_KIND_TRIGGER_NAMES = [
  'stage_state_media_kind_ai',
  'assets_media_kind_stage_state_au',
] as const;

/**
 * Rebuilds every `stage_state.media_kind` from `assets`.
 *
 * Migration `0002`'s backfill, the importer's after-a-triggerless-load pass,
 * and the repair any operator can run if the column is ever doubted.
 *
 * Two statements rather than one blanket `UPDATE … SET media_kind = (SELECT …)`,
 * because that form rewrites all 4.9 million rows to put most of them back the
 * way they were. Each of these touches only the rows that are actually wrong,
 * found through `assets_media_kind_av` and `stage_claim_media` respectively —
 * 1.3 s against a full rewrite's minutes.
 */
export const STAGE_STATE_MEDIA_KIND_RECOMPUTE_SQL = `
UPDATE stage_state
   SET media_kind = (SELECT media_kind FROM assets WHERE id = stage_state.asset_id)
 WHERE asset_id IN (SELECT id FROM assets WHERE media_kind IN ('video', 'audio'));

UPDATE stage_state
   SET media_kind = 'image'
 WHERE media_kind IN ('video', 'audio')
   AND asset_id IN (SELECT id FROM assets WHERE media_kind = 'image');
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
 *
 * This table is the only home for the subdocument — there is no mirroring JSON
 * column on `assets`. `toDetailDto` returns the `enrichment` object on the
 * wire, so the port builds it from these three rows; keeping a copy on the
 * asset row as well would be a second source of truth for the same state.
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
