/**
 * The three statements behind one row of Settings → Workers — pending, ready
 * and dead-lettered (#3804).
 *
 * Split out of `stage-runtime.sql.ts` because they are no longer that module's
 * statements with the `LIMIT` taken off. The claim reads five candidates and
 * stops; these read the whole backlog and count it, so "what can this answer
 * from an index" is a different question for each, and the answers are what
 * this module is for. The gates themselves are still imported from there, so
 * the two cannot drift.
 *
 * ## The gates are the claim's; one spelling is not
 *
 * `ready` has to ask the claim's own question, or the split the page renders —
 * "N ready, M blocked on an upstream stage" — stops meaning anything. But
 * asking it the claim's way costs what the claim never pays, because the claim
 * stops at five rows and this does not:
 *
 *  - The claim tests liveness and the damaged tag with an `EXISTS` over
 *    `assets`. Keyed, but `assets_live_id` is partial on liveness alone, so
 *    `damaged_since IS NULL` still has to read the asset row — the widest row
 *    in the schema — once per backlog row. Here that becomes
 *    {@link STAGE_STATE_CLAIMABLE_NARROWING}, the trigger-owned mirror of
 *    exactly those three columns, which `stage_claim` carries as a trailing
 *    member. The scan stays covering and never leaves the index. Note that for
 *    a count the mirror is authoritative rather than a narrowing: almost every
 *    asset is live, so keeping the `EXISTS` behind it would leave the probe
 *    running on almost every row and buy nothing.
 *  - The `dependsOn` gate keeps {@link DEPENDENCY_SQL} verbatim, because
 *    nothing cheaper is equivalent. Rows are dense by design but not by
 *    constraint, and an asset with no row for the dependency reads as blocked
 *    today; every set-based rewrite that was measured either assumed density or
 *    materialised a set larger than the backlog it was filtering. What made it
 *    affordable instead is the `stage_dep` index, which answers the probe from
 *    40 bytes of covering index rather than from a 4 million-row `WITHOUT
 *    ROWID` B-tree that carries every row body.
 *
 * Measured on a generated library of the production shape, twelve stages
 * sequentially: 2,092 ms of pending and 3,518 ms of ready became 87 ms and
 * 876 ms. `scripts/sqlite-bench/stage-backlog-counts.ts` is the measurement,
 * and it checks stage by stage that the old and new spellings agree.
 *
 * ## The in-flight exclusion stays out, deliberately
 *
 * The claim also excludes the ids its own process is working on. That set is
 * one process's private bookkeeping, and a count that shrank because a worker
 * happened to be busy would report a different backlog to every reader.
 */

import { STAGE_STATE_CLAIMABLE_NARROWING } from '../ddl/stage-state.ts';
import { CLAIMABLE_GATES, dependencyClauses, residualClauses } from './stage-runtime.sql.ts';

/**
 * How many assets this stage still owes work on, ignoring the retry gate and
 * the dependency gates — the Workers page's "pending".
 *
 * Parameters: `stage`, `targetVersion`, then the residual's own parameters.
 */
export function stagePendingCountSql(residualSql?: string): string {
  const clauses = [
    'stage = ? AND version < ? AND dead = 0',
    STAGE_STATE_CLAIMABLE_NARROWING,
    ...residualClauses(residualSql),
  ];
  return `SELECT COUNT(*) AS n
     FROM stage_state
    WHERE ${clauses.join('\n      AND ')}`;
}

/**
 * How many of those assets could start right now — the Workers page's "ready",
 * and the other half of the split it renders as "N ready · M blocked on an
 * upstream stage".
 *
 * Every gate the claim applies, which is the point: `blocked = pending - ready`
 * is only a meaningful number if `ready` is the claim's own question. A stage
 * parked behind `dependsOn` otherwise reports a large pending backlog with
 * nothing to say that none of it can move, which is the exact diagnosis the
 * split exists to give.
 *
 * Parameters: `stage`, `targetVersion`, `now`, then two per dependency, then
 * the residual's own parameters.
 */
export function stageReadyCountSql(dependencyCount: number, residualSql?: string): string {
  const clauses = [
    'stage = ?',
    CLAIMABLE_GATES,
    STAGE_STATE_CLAIMABLE_NARROWING,
    ...dependencyClauses(dependencyCount),
    ...residualClauses(residualSql),
  ];
  return `SELECT COUNT(*) AS n
     FROM stage_state
    WHERE ${clauses.join('\n      AND ')}`;
}

/** Parked rows for one stage — the dead-letter count, served by `stage_dead`. */
export const STAGE_DEAD_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM stage_state WHERE stage = ? AND dead = 1`;
