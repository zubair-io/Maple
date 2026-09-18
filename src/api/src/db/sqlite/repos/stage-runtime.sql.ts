/**
 * Every statement the ported stage runtime runs, in one place (#3748).
 *
 * Separated from the functions that call it for the same reason
 * `assets.sql.ts` is: the shape of these statements is the whole performance
 * argument, and a reviewer should be able to read them together and check them
 * against `docs/sqlite-schema.md`'s query-to-index map without stepping through
 * TypeScript.
 *
 * Three shapes in here are load-bearing.
 *
 * **The candidate scan reads one index.** {@link stageClaimCandidatesSql} leads
 * with `stage = ?`, which is the first column of `stage_claim`
 * (`stage, version, dead, next_attempt_at, asset_id`); `version`, `dead` and
 * `next_attempt_at` are the next three, so the gates are answered from the
 * index and the scan stops at the limit. Measured in the schema benchmark at
 * 0.05 ms for 500 candidates over 12 million rows. The Mongo query it replaces
 * needs two dedicated indexes per stage — 24 of the 50 on the collection — and
 * that count grows every time a stage is registered.
 *
 * `ORDER BY version` is free because it is the index's own order once `stage`
 * is pinned by equality — least-processed assets first, with no sort step.
 * Adding `asset_id` as a tie-break would NOT be free: `dead` and
 * `next_attempt_at` sit between them in the index, so the planner would have to
 * materialise and sort. `assets.query-plan.test.ts`'s sibling suite pins this.
 *
 * **Everything about an asset is a semi-join.** The liveness and damaged gates
 * are an `EXISTS` over `assets`, so `stage_state` stays the outer loop and the
 * ordered index scan terminates at the limit rather than the planner leading
 * with `assets` and filtering 12 million stage rows against it.
 *
 * **The live predicate is spelled exactly one way.** SQLite only uses a
 * partial index when the query's own `WHERE` provably implies the index's, and
 * the implication test is textual enough that a paraphrase loses the index.
 * {@link LIVE_ASSET_PREDICATE} is imported from the DDL rather than retyped.
 */

import { LIVE_ASSET_PREDICATE } from '../ddl/assets.ts';
import { placeholders } from './assets.sql.ts';

/** The bookkeeping columns a claim hands back, in `stage_state` order. */
const STAGE_STATE_COLUMNS = `
  asset_id, version, attempts, last_error, processed_at, dead, failed_at, next_attempt_at`;

/**
 * The three gates that decide whether a `stage_state` row is claimable, minus
 * the stage name itself.
 *
 * Shared verbatim between the candidate scan and the claim's own re-check, so
 * the two cannot drift: the re-check is only exclusive if it asks the same
 * question the scan asked.
 *
 * `next_attempt_at IS NULL OR next_attempt_at <= ?` is the retry gate (#2729)
 * and the claim lease in one. NULL means claimable now, which is how every row
 * seeded at version 0 reads, so nothing needs a migration to become eligible —
 * the same property the Mongo filter bought by writing the gate as
 * `$not: { $gt: now }` rather than `$lte`.
 */
const CLAIMABLE_GATES = `
    version < ?
    AND dead = 0
    AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`;

/**
 * The asset-level park: a claim skips an asset that is soft-deleted, has no
 * live on-disk location, or is tagged damaged.
 *
 * The first two are the standard live predicate. An asset whose every location
 * is non-live (bytes replaced, or the file vanished) has nothing to process and
 * is parked for EVERY stage until the missing-reaper resolves it. `damaged` is
 * the operator-clearable tag a file-reading stage stamps when the bytes turn
 * out to be unreadable; it parks the asset for every stage too.
 */
const ASSET_CLAIMABLE_SQL = `
    EXISTS (
      SELECT 1 FROM assets
       WHERE id = stage_state.asset_id
         AND ${LIVE_ASSET_PREDICATE}
         AND damaged_since IS NULL
    )`;

/** One `dependsOn` entry: the named stage must have reached `minVersion`. */
const DEPENDENCY_SQL = `
    EXISTS (
      SELECT 1 FROM stage_state dep
       WHERE dep.asset_id = stage_state.asset_id AND dep.stage = ? AND dep.version >= ?
    )`;

/**
 * The candidate scan. Parameters, in order: `stage`, `targetVersion`, `now`,
 * then two per dependency, then one per in-flight id, then the residual's own
 * parameters, then `limit`.
 *
 * `residualSql` is the SQLite spelling of `StageConfig.claimFilter` — the
 * optional extra predicate a stage that only applies to a subset of assets
 * supplies, so it never claims the rest. It is AND-ed on, exactly as the Mongo
 * builder wraps the base query in `$and`, so it cannot collide with a gate
 * above.
 */
export function stageClaimCandidatesSql(
  dependencyCount: number,
  inFlightCount: number,
  residualSql?: string,
): string {
  const dependencies = Array.from({ length: dependencyCount }, () => DEPENDENCY_SQL);
  const inFlight = inFlightCount === 0 ? [] : [`asset_id NOT IN (${placeholders(inFlightCount)})`];
  const residual = residualSql === undefined ? [] : [`(${residualSql})`];
  const clauses = [
    'stage = ?',
    CLAIMABLE_GATES,
    ASSET_CLAIMABLE_SQL,
    ...dependencies,
    ...inFlight,
    ...residual,
  ];
  return `SELECT ${STAGE_STATE_COLUMNS}
     FROM stage_state
    WHERE ${clauses.join('\n    AND ')}
    ORDER BY version
    LIMIT ?`;
}

/**
 * The claim itself: take one candidate, or find it already taken.
 *
 * Parameters: `leaseUntil`, `asset_id`, `stage`, `targetVersion`, `now`.
 *
 * Two things happen in this one statement, and both matter.
 *
 * `attempts = attempts + 1` persists the attempt BEFORE the handler runs, so
 * an uncatchable process death — a native `abort()` inside libraw or onnx —
 * still counts against the attempt budget. That is the property #897 added and
 * it is why {@link STAGE_CRASH_EXHAUSTED_SQL} exists to sweep up after it.
 *
 * `next_attempt_at = <lease>` is what makes the claim exclusive. The gates
 * repeated in the `WHERE` are the same ones the candidate scan applied, so a
 * claimer that lost the race updates zero rows and learns it lost from
 * `changes`. On Mongo the equivalent guard is the runner's in-process
 * `inFlight` set, which protects one process against itself and nothing
 * against a second one; here the lease is in the row, so a second process, a
 * second thread or a restart all see it. When the handler finishes, the
 * writeback overwrites the lease — cleared on success, replaced by the real
 * retry backoff on failure — so the lease only outlives the attempt when the
 * process died holding it, which is exactly when something should reclaim it.
 */
export const STAGE_CLAIM_SQL = `
  UPDATE stage_state
     SET attempts = attempts + 1, next_attempt_at = ?
   WHERE asset_id = ? AND stage = ?
     AND ${CLAIMABLE_GATES}`;

/**
 * A clean run: version at target, retry bookkeeping cleared.
 *
 * The failure trail is cleared along with it so a recovered asset does not
 * carry a stale error string (#2730) or a backoff gate (#2729) that would hold
 * its NEXT version bump hostage for the remainder of the ladder.
 *
 * Parameters: `version`, `last_error`, `processed_at`, `asset_id`, `stage`.
 */
export const STAGE_SUCCESS_SQL = `
  UPDATE stage_state
     SET version = ?, attempts = 0, last_error = ?, processed_at = ?,
         dead = 0, failed_at = NULL, next_attempt_at = NULL
   WHERE asset_id = ? AND stage = ?`;

/**
 * Mark another stage stale so its poll loop rebuilds from what this one just
 * wrote — the `invalidates` mechanism (#2172) and the upstream half of a
 * `rearm` (#2177), which are the same field reset.
 *
 * An upsert rather than an update for the reason `assets.stage-rearm.ts`
 * spells out: stage rows are seeded when an asset is created, so the row
 * normally exists, and "normally" is exactly the assumption that produced
 * #2177. The `SELECT … FROM assets` source keeps it from inserting a row for
 * an asset that does not exist, which the foreign key would reject and which
 * would roll the whole transaction back.
 *
 * Parameters: `stage`, `asset_id`.
 */
export const STAGE_INVALIDATE_SQL = `
  INSERT INTO stage_state (asset_id, stage, version, attempts, last_error, processed_at, dead)
  SELECT id, ?, 0, 0, NULL, NULL, 0 FROM assets WHERE id = ?
  ON CONFLICT (asset_id, stage) DO UPDATE SET
    version = 0, attempts = 0, last_error = NULL, processed_at = NULL, dead = 0`;

/**
 * The claiming stage's own row after a `rearm`: left below target with its
 * claim-time attempt kept, so the `dependsOn` gate parks it until the upstream
 * stage completes and it re-claims automatically. The lease is cleared because
 * the asset is parked by the dependency, not by a backoff.
 *
 * Parameters: `last_error`, `dead`, `asset_id`, `stage`.
 */
export const STAGE_REARM_SELF_SQL = `
  UPDATE stage_state
     SET last_error = ?, dead = ?, next_attempt_at = NULL
   WHERE asset_id = ? AND stage = ?`;

/**
 * A handler that classified the bytes as unreadable up front.
 *
 * `attempts = 1` records that it was processed once and classified rather than
 * retried to exhaustion, and `dead = 1` plus the asset's damaged tag are what
 * park it. `version` is deliberately NOT bumped: if an operator clears the tag,
 * the asset reprocesses from here.
 *
 * Parameters: `last_error`, `asset_id`, `stage`.
 */
export const STAGE_DAMAGED_SQL = `
  UPDATE stage_state
     SET attempts = 1, last_error = ?, dead = 1, next_attempt_at = NULL
   WHERE asset_id = ? AND stage = ?`;

/**
 * A failed attempt. `dead` is computed by the caller from the attempt number
 * that was already persisted at claim time, so this statement never
 * re-increments.
 *
 * Parameters: `last_error`, `dead`, `failed_at`, `next_attempt_at`,
 * `asset_id`, `stage`.
 */
export const STAGE_FAILURE_SQL = `
  UPDATE stage_state
     SET last_error = ?, dead = ?, failed_at = ?, next_attempt_at = ?
   WHERE asset_id = ? AND stage = ?`;

/**
 * Give back a claim without spending an attempt, and make the row immediately
 * claimable again.
 *
 * The ENOENT path: a file-reading stage found the original gone, the asset is
 * tagged for the missing-reaper instead, and it was never genuinely attempted.
 * Clearing the lease matters as much as the decrement — the asset is parked by
 * the location's `missing_since` (which drops it out of {@link
 * ASSET_CLAIMABLE_SQL}), and if the reaper recovers the file it should be
 * claimable at once rather than sitting out a lease it never used.
 *
 * Parameters: `asset_id`, `stage`.
 */
export const STAGE_CLAIM_ROLLBACK_SQL = `
  UPDATE stage_state
     SET attempts = MAX(attempts - 1, 0), next_attempt_at = NULL
   WHERE asset_id = ? AND stage = ?`;

/**
 * Candidates whose attempt budget was consumed without ever completing — the
 * signature of an uncatchable native death mid-handler (#897).
 *
 * A normal throw dead-letters in the runner's catch, so a row below target,
 * not dead, and already at `maxAttempts` can only have got there by the
 * process dying while holding it. They are marked dead and NOT re-dispatched;
 * otherwise one poison asset re-claims on every respawn and the tier never
 * drains.
 *
 * Note this reads the candidate set BEFORE the lease is applied, so it sees
 * the rows a claim is about to consider. Parameters: `stage`,
 * `targetVersion`, `now`, `maxAttempts`, `limit`.
 */
export const STAGE_CRASH_EXHAUSTED_SQL = `
  SELECT asset_id, attempts
    FROM stage_state
   WHERE stage = ?
     AND ${CLAIMABLE_GATES}
     AND attempts >= ?
   ORDER BY version
   LIMIT ?`;

/** Park one crash-exhausted row. Parameters: `last_error`, `asset_id`, `stage`. */
export const STAGE_MARK_DEAD_SQL = `
  UPDATE stage_state
     SET dead = 1, last_error = ?, next_attempt_at = NULL
   WHERE asset_id = ? AND stage = ?`;

/**
 * The version-bump reset: re-queue everything below the new target.
 *
 * Clears `dead` and the attempt count but leaves `version` alone — the row is
 * already below target, which is what makes it claimable. Parameters:
 * `stage`, `targetVersion`.
 */
export const STAGE_VERSION_BUMP_RESET_SQL = `
  UPDATE stage_state
     SET dead = 0, attempts = 0, last_error = NULL, next_attempt_at = NULL
   WHERE stage = ? AND version < ?`;

/**
 * Seed one stage's row for one asset, at version 0.
 *
 * Rows are dense by design: on Mongo a missing `stages.<name>` subdocument is
 * claimable because BSON orders a missing field below any number, and the SQL
 * equivalent of that is an anti-join against `assets`, which cannot use an
 * index on `stage_state` at all. Seeding makes the claim a plain index range
 * scan. Parameters: `asset_id`, `stage`.
 */
export const SEED_STAGE_ROW_SQL = `
  INSERT INTO stage_state (asset_id, stage) VALUES (?, ?)
  ON CONFLICT (asset_id, stage) DO NOTHING`;

/**
 * Register a stage across every existing asset — the one statement that
 * replaces two index definitions and a rebuild on the next boot.
 *
 * This is what makes assets that predate a stage retroactively eligible for
 * it, the role `ALL_STAGE_NAMES` plays for the Mongo status counters.
 *
 * `WHERE true` is not decoration. SQLite's parser cannot tell an upsert's `ON
 * CONFLICT` from a join's `ON` when the `INSERT` is fed by a `SELECT`, so the
 * grammar requires the `SELECT` to carry a `WHERE` clause before an upsert
 * clause; without one this is a syntax error at `DO`.
 *
 * Soft-deleted assets get a row too, deliberately: the rows are dense by
 * design, a trashed asset can be restored, and the claim's own liveness gate is
 * what keeps it from being picked up meanwhile.
 *
 * Parameter: `stage`.
 */
export const REGISTER_STAGE_SQL = `
  INSERT INTO stage_state (asset_id, stage) SELECT id, ? FROM assets WHERE true
  ON CONFLICT (asset_id, stage) DO NOTHING`;

/** Tag an asset damaged, parking it out of every stage's claim. */
export const TAG_DAMAGED_SQL = `
  UPDATE assets
     SET damaged_since = ?, damaged_stage = ?, damaged_reason = ?
   WHERE id = ? AND damaged_since IS NULL`;

/**
 * Stamp `missing_since` on one location. First detection wins — the `IS NULL`
 * guard is what keeps a second tick from moving a timestamp the reaper is
 * already counting from.
 */
export const TAG_LOCATION_MISSING_SQL = `
  UPDATE asset_locations
     SET missing_since = ?, missing_reason = ?
   WHERE asset_id = ? AND ordinal = ? AND missing_since IS NULL`;

/**
 * How many assets this stage still owes work on, ignoring the retry gate and
 * the dependency gates — the Workers page's "pending".
 *
 * Parameters: `stage`, `targetVersion`, then the residual's own parameters.
 */
export function stagePendingCountSql(residualSql?: string): string {
  const residual = residualSql === undefined ? '' : `\n     AND (${residualSql})`;
  return `SELECT COUNT(*) AS n
     FROM stage_state
    WHERE stage = ? AND version < ? AND dead = 0
      AND ${ASSET_CLAIMABLE_SQL}${residual}`;
}

/** Parked rows for one stage — the dead-letter count, served by `stage_dead`. */
export const STAGE_DEAD_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM stage_state WHERE stage = ? AND dead = 1`;
