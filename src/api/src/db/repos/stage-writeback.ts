/**
 * What a stage records when a handler returns or throws — the SQLite port of
 * the writeback half of `workers/run-stage.ts` and of
 * `workers/stage-failure.ts` (#3748).
 *
 * ## Everything is a statement, nothing is a write
 *
 * Each function here builds {@link SqlStatement}s rather than executing them.
 * That is what lets `StageWritebackBatch` (`stage-writeback.batch.ts`) put a
 * whole tick's results
 * into one `BEGIN IMMEDIATE`, which is where the single-writer design pays
 * off: the Mongo runner issues one `updateOne` per asset per event — a batch
 * of 20 costs 20 round trips and 20 independent commits — and the same 20
 * results here are one transaction on the writer thread. It also removes a
 * failure mode rather than only cost: on Mongo a patch and its `invalidates`
 * are one document write and therefore atomic, but the several writes a single
 * asset's result can need are not, so a crash between them leaves a stage
 * marked done with its downstream never re-armed. In one transaction that
 * cannot happen.
 *
 * ## Two behaviours that must survive, because both were bugs
 *
 * **A version-gated stage marks an asset permanently handled.** `skip`, `wrote`
 * and `patch` all land {@link stageSuccessStatements}, which sets `version` to
 * the stage's target — the asset is done for this stage until the target is
 * bumped. A stage whose external configuration is absent must therefore never
 * reach this path, or it silently marks every asset done before the
 * configuration exists. The guard for that is upstream and unchanged:
 * `geocode` boots `pausedOnFirstBoot: true`, and a paused stage never claims.
 *
 * **The Workers page counters stay persisted by the worker.** Counting is
 * cheap now — `stage_dead` answers a dead count from the index alone — but the
 * contract is not about cost. The demand flag and the worker-side pass are how
 * the status endpoint stays off the database entirely, and re-deriving counts
 * on the request path is what made it an 8-second endpoint (#3491). See
 * `stage-state.repo.ts` for the count statements the worker's pass uses.
 *
 * ## Every writeback is fenced on the lease it was granted
 *
 * {@link StageTarget} carries the lease string the claim stamped, and each of
 * the five statements that write the claimed row ends in `next_attempt_at = ?`
 * against it. A handler that outran its lease has already lost the asset to a
 * second claimer, so its writeback matches zero rows and leaves that claim
 * alone, rather than clearing the lease and handing the asset to a third while
 * two handlers are still running. A stage whose handler can legitimately run
 * that long renews instead — `renewStageLease` in `stage-claim.ts`.
 *
 * What the fence does NOT cover is the handler's own `extra` statements and
 * the `invalidates` upserts, which write the asset rather than the claim. A
 * late handler's description or thumbnail path still lands, and the current
 * claimer's will land after it — last writer wins, exactly as two Mongo
 * workers on one asset behave today. The fence is about the bookkeeping row,
 * which is the thing that must not be released by someone who no longer holds
 * it.
 */

import type { StageResult } from '../../workers/stage-config.ts';
import type { SqlStatement } from '../sqlite/protocol.ts';
import {
  STAGE_CLAIM_ROLLBACK_SQL,
  STAGE_DAMAGED_SQL,
  STAGE_FAILURE_SQL,
  STAGE_INVALIDATE_SQL,
  STAGE_REARM_SELF_SQL,
  STAGE_SUCCESS_SQL,
  TAG_DAMAGED_SQL,
  TAG_LOCATION_MISSING_BY_ADDRESS_SQL,
  TAG_LOCATION_MISSING_SQL,
} from './stage-runtime.sql.ts';

/** A stage name is a compile-time constant; anything else is a typo. */
const STAGE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * Reject a malformed name in an `invalidates` list.
 *
 * On Mongo this guarded against a `.`- or `$`-bearing value silently creating
 * unintended nested fields inside a `$set` path. Here the name is a bound
 * parameter and cannot reach the SQL text, so the injection is gone — but the
 * mistake it caught is not. `invalidates: ['meili.version']` means the author
 * thought they were writing a field path, and honouring it would create a
 * `stage_state` row for a stage called `meili.version` that no runner will ever
 * claim. Failing the attempt loudly is still the right answer.
 */
function assertStageNames(names: readonly string[]): void {
  const invalid = names.filter((name) => !STAGE_NAME_PATTERN.test(name));
  if (invalid.length > 0) {
    throw new Error(`invalid stage name in invalidates: ${invalid.join(', ')}`);
  }
}

/**
 * Mark downstream stages stale so their poll loops rebuild from what this
 * stage just wrote (#2172). The writing stage's own name is excluded: its row
 * is the runner's, written in the same transaction.
 */
export function invalidationStatements(
  names: readonly string[] | undefined,
  ownName: string,
  assetId: string,
): SqlStatement[] {
  const list = names ?? [];
  assertStageNames(list);
  return list
    .filter((name) => name !== ownName)
    .map((name) => ({ sql: STAGE_INVALIDATE_SQL, params: [name, assetId] }));
}

/** The shared shape of every writeback: which asset, which stage, which claim. */
export interface StageTarget {
  assetId: string;
  stage: string;
  targetVersion: number;
  /**
   * The lease the claim stamped — `ClaimedStageRow.next_attempt_at`, or the
   * value the last `renewStageLease` returned. Every statement that writes the
   * claimed row is fenced on it, so a writeback from an attempt whose lease has
   * already been taken over matches nothing.
   */
  lease: string;
}

/**
 * A clean run — `patch`, `wrote` or `skip`.
 *
 * `skipReason` is the one difference between them on the database side: a skip
 * records why in `last_error` and still resets `attempts` to 0, so it can never
 * dead-letter. `invalidates` and `extra` both land in the same transaction as
 * the stage row, which is what makes the patch and the re-arm atomic together.
 */
export function stageSuccessStatements(
  target: StageTarget,
  options: {
    processedAt?: Date;
    skipReason?: string;
    invalidates?: readonly string[];
    /** The handler's own field writes. See {@link assertNoStageState}. */
    extra?: readonly SqlStatement[];
  } = {},
): SqlStatement[] {
  const extra = options.extra ?? [];
  assertNoStageState(extra);
  return [
    ...extra,
    ...invalidationStatements(options.invalidates, target.stage, target.assetId),
    {
      sql: STAGE_SUCCESS_SQL,
      params: [
        target.targetVersion,
        options.skipReason === undefined ? null : `skip: ${options.skipReason}`,
        (options.processedAt ?? new Date()).toISOString(),
        target.assetId,
        target.stage,
        target.lease,
      ],
    },
  ];
}

/**
 * A handler's own writes must not touch `stage_state` — that row belongs to
 * the runner, which writes it in the same transaction.
 *
 * The Mongo runner makes the same check by looking for `stages.`-prefixed keys
 * in the returned patch. Reading the SQL text is the nearest equivalent and
 * carries the same caveat: it catches the programming error it is aimed at,
 * not a determined caller. A handler that wrote its own bookkeeping would
 * silently fight the runner for the row, which is the failure worth a loud
 * throw at development time.
 */
function assertNoStageState(statements: readonly SqlStatement[]): void {
  const offending = statements.filter((statement) => /\bstage_state\b/i.test(statement.sql));
  if (offending.length > 0) {
    throw new Error(
      `Handler returned statements writing stage_state, which the runner owns: ${offending.length}`,
    );
  }
}

/**
 * A prerequisite artefact from an upstream stage is missing even though that
 * stage's version says it ran (#2177).
 *
 * Resets the upstream stage so its loop regenerates the artefact, and leaves
 * this stage below target with its claim-time attempt kept — the `dependsOn`
 * gate then parks the asset until the upstream completes, at which point this
 * stage re-claims it. Once out of attempts the upstream reset stops: this
 * stage can no longer claim the asset, so another regeneration round is pure
 * churn. A pair that never converges dead-letters here rather than
 * ping-ponging forever.
 */
function stageRearmStatements(
  target: StageTarget,
  rearm: { stage: string; reason: string },
  dead: boolean,
): SqlStatement[] {
  return [
    ...(dead ? [] : invalidationStatements([rearm.stage], target.stage, target.assetId)),
    {
      sql: STAGE_REARM_SELF_SQL,
      params: [
        `awaiting ${rearm.stage}: ${rearm.reason}`,
        dead ? 1 : 0,
        target.assetId,
        target.stage,
        target.lease,
      ],
    },
  ];
}

/**
 * Bytes the handler classified as unreadable up front, plus the asset tag that
 * parks it out of every other stage's claim.
 *
 * `version` is deliberately not bumped — if an operator clears the tag, the
 * asset reprocesses from here.
 */
function stageDamagedStatements(
  target: StageTarget,
  reason: string,
  at: Date = new Date(),
): SqlStatement[] {
  return [
    { sql: STAGE_DAMAGED_SQL, params: [reason, target.assetId, target.stage, target.lease] },
    tagDamagedStatement(target.assetId, target.stage, reason, at),
  ];
}

/**
 * Tag an asset damaged. Idempotent by its `damaged_since IS NULL` guard, so a
 * second stage reaching the same conclusion does not overwrite the first
 * detection the operator is triaging from.
 */
export function tagDamagedStatement(
  assetId: string,
  stage: string,
  reason: string,
  at: Date = new Date(),
): SqlStatement {
  return { sql: TAG_DAMAGED_SQL, params: [at.toISOString(), stage, reason, assetId] };
}

/**
 * Stamp `missing_since` on one location, after the caller has confirmed the
 * file is genuinely absent (#2171 — an unmounted root or a race must not tag a
 * present file). First detection wins.
 */
export function tagLocationMissingStatement(
  assetId: string,
  ordinal: number,
  reason: string,
  at: Date = new Date(),
): SqlStatement {
  return {
    sql: TAG_LOCATION_MISSING_SQL,
    params: [at.toISOString(), reason, assetId, ordinal],
  };
}

/**
 * The same stamp, for the caller that holds the location's address rather than
 * its ordinal — the runner's ENOENT path, which resolved
 * `(library_id, path, filename)` into the absolute path it failed to read.
 */
export function tagLocationMissingByAddressStatement(
  assetId: string,
  address: { libraryId: string; path: string; filename: string },
  reason: string,
  at: Date = new Date(),
): SqlStatement {
  return {
    sql: TAG_LOCATION_MISSING_BY_ADDRESS_SQL,
    params: [at.toISOString(), reason, assetId, address.libraryId, address.path, address.filename],
  };
}

/**
 * Hand a claim back without spending an attempt. The ENOENT path: the original
 * is gone, the asset is parked for the missing-reaper by its location tag
 * instead, and it was never genuinely attempted.
 */
export function claimRollbackStatement(target: StageTarget): SqlStatement {
  return { sql: STAGE_CLAIM_ROLLBACK_SQL, params: [target.assetId, target.stage, target.lease] };
}

/** What a failed attempt decided, before it is written. */
export interface StageFailureOutcome {
  /** True when the asset is now dead-lettered and will not be re-claimed. */
  dead: boolean;
  /** The message written to `last_error`. */
  message: string;
  /** Milliseconds until the retry gate lifts, or null when dead-lettered. */
  retryInMs: number | null;
  /** Whether the error itself said retrying was pointless. */
  terminal: boolean;
  statements: SqlStatement[];
}

/**
 * Does an error assert that retrying is pointless?
 *
 * Read structurally rather than via `instanceof RemoteError`: that class lives
 * under `enrichment/describe-providers/`, and the generic stage runtime
 * importing from one stage's provider tree would invert the dependency for
 * every other stage. Any error declaring a boolean `retryable` participates,
 * and only an explicit `false` counts — an error that does not carry the flag
 * says nothing about retryability, so it keeps its full attempt budget.
 */
function isTerminalError(err: unknown): boolean {
  return (err as { retryable?: unknown } | null | undefined)?.retryable === false;
}

/**
 * The statements and the verdict for one failed attempt.
 *
 * `attemptNo` was already persisted by the claim, which is why `dead` is
 * computed from it rather than by re-reading or re-incrementing: an uncatchable
 * native death still counts, because the increment happened before the handler
 * ran.
 *
 * A terminal error dead-letters immediately instead of spending the remaining
 * budget. A 4xx means the request itself is wrong, so walking the rest of the
 * backoff ladder cannot produce a different answer — it only delays the
 * dead-letter by the length of the ladder.
 *
 * `retryDelay` is injected rather than imported so the ladder stays in
 * `workers/loop-policy.ts`, which is pure and needs no port.
 */
export function stageFailureStatements(input: {
  target: StageTarget;
  attemptNo: number;
  maxAttempts: number;
  err: unknown;
  retryDelayMs: (attemptNo: number) => number;
  failedAt?: Date;
}): StageFailureOutcome {
  const { target, attemptNo, maxAttempts, err } = input;
  const message = err instanceof Error ? err.message : String(err);
  const terminal = isTerminalError(err);
  const dead = terminal || attemptNo >= maxAttempts;
  const failedAt = input.failedAt ?? new Date();
  const retryInMs = dead ? null : input.retryDelayMs(attemptNo);
  const nextAttemptAt =
    retryInMs === null ? null : new Date(failedAt.getTime() + retryInMs).toISOString();

  return {
    dead,
    message,
    retryInMs,
    terminal,
    statements: [
      {
        sql: STAGE_FAILURE_SQL,
        params: [
          message,
          dead ? 1 : 0,
          failedAt.toISOString(),
          nextAttemptAt,
          target.assetId,
          target.stage,
          target.lease,
        ],
      },
    ],
  };
}

/**
 * What a stage's handler returned, in its SQLite spelling.
 *
 * The same four variants `StageResult` already has, with the patch's type
 * argument filled in: on Mongo a patch is a map of document fields the runner
 * folds into its own `$set`, and here it is the statements the handler wants
 * run in the runner's transaction. Nothing else about the union changes, which
 * is why it is the existing type rather than a parallel one.
 */
export type SqliteStageResult = StageResult<readonly SqlStatement[]>;

/** What {@link stageResultStatements} needs to know about the attempt. */
export interface StageAttempt {
  target: StageTarget;
  /** Attempt number the claim already persisted, 1-based. */
  attemptNo: number;
  maxAttempts: number;
  /** Resolved `dependsOn` names — a `rearm` must name one of these. */
  dependsOn: readonly string[];
  tagsDamagedOnDeadLetter?: boolean;
  at?: Date;
}

/**
 * Turn one handler result into the statements that record it.
 *
 * The per-variant writeback that lives inline in the Mongo runner's dispatch
 * body, lifted out so a tick can collect every asset's statements and commit
 * them together. Throwing here is deliberate for the two misuse cases — a
 * `rearm` naming a stage this one does not depend on, and a `damaged` from a
 * stage that is not a damage-tagging stage — because both are programming
 * errors that would otherwise strand the asset silently, and the runner's
 * catch turns a throw into an ordinary failed attempt with the reason in
 * `last_error`.
 */
export function stageResultStatements(
  attempt: StageAttempt,
  result: SqliteStageResult,
): SqlStatement[] {
  const { target, at } = attempt;
  if ('patch' in result) {
    return stageSuccessStatements(target, {
      processedAt: at,
      invalidates: result.invalidates,
      extra: result.patch,
    });
  }
  if ('wrote' in result) return stageSuccessStatements(target, { processedAt: at });
  if ('skip' in result) {
    return stageSuccessStatements(target, { processedAt: at, skipReason: result.skip });
  }
  if ('rearm' in result) {
    const dep = result.rearm.stage;
    if (!attempt.dependsOn.includes(dep)) {
      throw new Error(
        `stage '${target.stage}' returned { rearm: '${dep}' } but does not depend on it`,
      );
    }
    return stageRearmStatements(target, result.rearm, attempt.attemptNo >= attempt.maxAttempts);
  }
  if (!attempt.tagsDamagedOnDeadLetter) {
    throw new Error(
      `stage '${target.stage}' returned { damaged } but is not a damage-tagging stage`,
    );
  }
  return stageDamagedStatements(target, result.damaged, at);
}
