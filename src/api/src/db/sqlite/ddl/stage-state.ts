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
-- each one: 7 ms a tick against 19, measured at production shape.
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
 * Dropping the equality costs `video-describe` 19 ms a tick instead of 7 at
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
 * The three `assets` columns that decide whether a stage may claim an asset,
 * as one expression over a given table alias (`''` for an unqualified
 * reference, `'NEW'` / `'OLD'` inside a trigger).
 *
 * The first two are `LIVE_ASSET_PREDICATE` verbatim — not a paraphrase of
 * it, which `stage-state.asset-claimable.test.ts` pins by substring — and the
 * third is the operator-clearable damaged tag. Together they are exactly the
 * question `ASSET_CLAIMABLE_SQL` asks per candidate row in the claim.
 */
export function assetClaimableExpression(qualifier = ''): string {
  const q = qualifier === '' ? '' : `${qualifier}.`;
  return `(${q}deleted_at IS NULL AND ${q}live_location_count > 0 AND ${q}damaged_since IS NULL)`;
}

/**
 * `stage_state.asset_claimable` — whether the asset behind this stage row is
 * live and undamaged, denormalised onto the stage row so the Workers page's
 * backlog counts can be answered from an index (#3804).
 *
 * ## What it costs today
 *
 * `countStageBacklog` asks the claim's question without the claim's `LIMIT`, so
 * each of its two counts walks the whole backlog for the stage and probes
 * `assets` once per row. The probe is keyed, but `assets_live_id` is partial on
 * liveness only, so `damaged_since IS NULL` still has to read the asset row —
 * and the asset row is the widest in the schema. Measured on a generated
 * library of the production shape (335,377 assets, 4.02 M stage rows), the
 * twelve stages' pending counts cost 2,082 ms and `describe`'s alone 350 ms.
 *
 * This is the same shape {@link STAGE_STATE_MEDIA_KIND_DDL} fixed for the
 * media-only stages, and the fix is the same: put the asset-level fact in the
 * stage row, and put the stage row's copy in the index the scan already reads.
 *
 * ## Here the mirror is authoritative, and that is the difference
 *
 * `media_kind` narrows and leaves `assets` to decide, because it feeds a claim
 * and a claim that skipped an asset on a stale mirror would strand it. These
 * two counts drop the `EXISTS` entirely, because narrowing would buy nothing —
 * almost every asset is live, so the probe would still run on almost every row.
 *
 * That is a smaller step than it reads. `live_location_count` is itself a
 * trigger-maintained roll-up that `LIVE_ASSET_PREDICATE` already treats as
 * authoritative everywhere in this schema, claims included; this column is the
 * same kind of value one hop further out, with the same trigger ownership and
 * the same one-statement repair. And the claim is untouched — it keeps its
 * `EXISTS` over `assets`, so the set of assets a stage actually claims is
 * unchanged, and a drifted mirror could only ever misreport a number on a
 * settings page.
 *
 * ## `stage_dep` is the other half
 *
 * With the probe gone, `ready`'s remaining cost is its `dependsOn` gate: an
 * `EXISTS` on the dependency's own stage row, keyed on the primary key of a
 * 4 million-row `WITHOUT ROWID` table whose B-tree carries every row body — 324
 * MB pulled through the page cache to read one integer per probe.
 * `stage_dep` answers the same question from 167 MB of covering index whose hot
 * region is the one dependency stage's 13 MB, and the claim's own `dependsOn`
 * probe picks it up for free. `ready` for the twelve stages falls from 3,584 ms
 * to 814 ms; the whole pass goes 5,666 ms to 896 ms.
 *
 * Under the refresher's own cadence (`STAGE_COUNTS_MIN_INTERVAL_MS` 5 s,
 * `BACKOFF_FACTOR` 3) that is the difference between a pass that throttles
 * itself and one that does not: anything slower than 1.67 s earns a rest longer
 * than the 5 s floor, so today's pass holds about a quarter of a reader
 * continuously and still refreshes the page more slowly than it asked to.
 *
 * It is deliberately NOT partial on the four stages that are dependencies
 * today. `stage` is free-form data precisely so that registering a stage is an
 * insert rather than a schema change, and an index that listed the dependency
 * graph would silently stop covering the first `dependsOn` edge added to a
 * stage outside the list.
 *
 * `DEFAULT 1` makes the `ALTER TABLE` metadata-only on 4 million rows, and
 * leaves the backfill only the minority to stamp.
 */
export const STAGE_STATE_ASSET_CLAIMABLE_DDL = `
ALTER TABLE stage_state ADD COLUMN asset_claimable INTEGER NOT NULL DEFAULT 1;

-- Both claim indexes gain the column as a trailing member, so the backlog
-- counts read it from the entry the scan is already on rather than seeking into
-- the row. Trailing, so the leading columns keep the order the claim's range
-- scan and its free ORDER BY depend on.
DROP INDEX stage_claim;
CREATE INDEX stage_claim
  ON stage_state (stage, version, dead, next_attempt_at, asset_id, asset_claimable);

DROP INDEX stage_claim_media;
CREATE INDEX stage_claim_media
  ON stage_state (stage, version, dead, next_attempt_at, asset_id, media_kind, asset_claimable)
  WHERE media_kind IN ('video', 'audio');

-- The dependency probe: one stage's rows in asset_id order, carrying the
-- version the gate compares. Covering, so the probe never touches the table.
CREATE INDEX stage_dep
  ON stage_state (stage, asset_id, version);
`;

/**
 * The gate a backlog count applies in place of the claim's `EXISTS` over
 * `assets`.
 *
 * Qualified by table name because the counts splice a stage's own residual into
 * the same `WHERE`, and a bare `asset_claimable` beside a correlated subquery
 * that also has the column in scope reads ambiguously to someone, even where
 * SQLite resolves it. Same reason {@link STAGE_STATE_MEDIA_NARROWING} is
 * qualified.
 */
export const STAGE_STATE_CLAIMABLE_NARROWING = `stage_state.asset_claimable = 1`;

/**
 * Keeps `stage_state.asset_claimable` in step with `assets`.
 *
 * Exported apart from the rest of the DDL so a bulk load can drop them, run
 * {@link STAGE_STATE_ASSET_CLAIMABLE_RECOMPUTE_SQL} once and put them back —
 * the same trade the media-kind and location-count triggers make, and a sharper
 * one here: a triggerless load leaves every asset at `live_location_count = 0`,
 * so restoring this trigger BEFORE the location counts are recomputed would
 * turn that one statement into 4 million single-row stage updates. Both
 * `import/run.ts` and the benchmark generator recompute first for that reason.
 *
 * The insert trigger is guarded by a `WHEN`, so the common case — a stage row
 * seeded for a live asset, which already reads 1 — costs one keyed lookup and
 * no write. The update trigger is narrowed to the three columns that can change
 * the answer and guarded on the answer actually flipping, so an ordinary EXIF
 * patch does not reach it and a re-run of the location-count recompute costs
 * one boolean comparison per asset rather than a write.
 */
export const STAGE_STATE_ASSET_CLAIMABLE_TRIGGER_DDL = `
CREATE TRIGGER stage_state_asset_claimable_ai AFTER INSERT ON stage_state
WHEN NEW.asset_claimable IS NOT
     (SELECT ${assetClaimableExpression()} FROM assets WHERE id = NEW.asset_id)
BEGIN
  UPDATE stage_state
     SET asset_claimable =
           (SELECT ${assetClaimableExpression()} FROM assets WHERE id = NEW.asset_id)
   WHERE asset_id = NEW.asset_id AND stage = NEW.stage;
END;

CREATE TRIGGER assets_claimable_stage_state_au
AFTER UPDATE OF deleted_at, live_location_count, damaged_since ON assets
WHEN ${assetClaimableExpression('NEW')} IS NOT ${assetClaimableExpression('OLD')}
BEGIN
  UPDATE stage_state
     SET asset_claimable = ${assetClaimableExpression('NEW')}
   WHERE asset_id = NEW.id;
END;
`;

/** Names of the triggers above, so a bulk load can drop them by name. */
export const STAGE_STATE_ASSET_CLAIMABLE_TRIGGER_NAMES = [
  'stage_state_asset_claimable_ai',
  'assets_claimable_stage_state_au',
] as const;

/**
 * Rebuilds every `stage_state.asset_claimable` from `assets`.
 *
 * Migration `0003`'s backfill, the pass a triggerless bulk load runs before it
 * restores the triggers, and the repair any operator can run if the column is
 * ever doubted.
 *
 * Two statements rather than one blanket `UPDATE … SET asset_claimable = (SELECT
 * …)`, for the reason the media-kind recompute gives: that form rewrites all 4
 * million rows to put almost all of them back the way they were. The first
 * statement lifts the minority that currently read 0 — found through
 * `stage_claim`, which carries the column, so it is a covering scan and not a
 * table read — and the second stamps the minority that should. Measured at
 * 352 ms on the production shape against a full rewrite's minutes.
 */
export const STAGE_STATE_ASSET_CLAIMABLE_RECOMPUTE_SQL = `
UPDATE stage_state SET asset_claimable = 1 WHERE asset_claimable = 0;

UPDATE stage_state
   SET asset_claimable = 0
 WHERE asset_id IN (
         SELECT id FROM assets WHERE NOT ${assetClaimableExpression()}
       );
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
