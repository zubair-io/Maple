/**
 * The stage claim — the SQLite port of `workers/claim-query.ts` and of the
 * find-and-dispatch half of `workers/run-stage.ts` (#3748).
 *
 * ## What a claim is now
 *
 * On Mongo, "which assets may this stage pick up" is a filter over the asset
 * document, because a stage's bookkeeping lives inside that document under
 * `stages.<name>`. Fifteen stages therefore need two indexes each on `assets`,
 * 24 of the 50 the collection declares, and the runner's own exclusivity is an
 * in-process `Set` of ids it excludes from the next filter.
 *
 * Here the bookkeeping is its own table keyed `(asset_id, stage)`, so the same
 * question is a range scan of one index that does not grow with the stage list,
 * and the claim is an `UPDATE` whose `WHERE` re-asks the scan's question inside
 * an immediate transaction. Two callers cannot both win: the first one's write
 * falsifies the gate for the second.
 *
 * ## Why identity comes from `changes` and not from `RETURNING`
 *
 * The natural spelling is `UPDATE … RETURNING`, and SQLite supports it. The
 * pool's transaction primitive does not carry rows back — `SqlWriteResult` is
 * `changes` plus `lastInsertRowid` — so a `RETURNING` clause would execute and
 * its rows would be discarded. Rather than widen the pool's protocol from this
 * slice, the claim issues one `UPDATE` per candidate inside a single
 * transaction and reads identity off each statement's `changes`: 1 means this
 * caller took the row, 0 means someone else did. It is one round trip to the
 * writer either way, and every statement is a primary-key probe into a
 * `WITHOUT ROWID` table.
 *
 * ## The lease
 *
 * A winning claim stamps `next_attempt_at` a lease ahead. That column already
 * means "the earliest this row may be claimed again", so the claim and the
 * retry backoff share one gate rather than needing a second column. The
 * writeback overwrites it on every terminal path — cleared on success,
 * replaced by the real backoff on failure — so a lease only outlives its
 * attempt when the process died holding it, which is precisely when the row
 * should become claimable again. {@link CLAIM_LEASE_MS} is sized for that, not
 * for the fast path.
 *
 * A lease that can expire is only safe if the rest of the runtime respects it,
 * and that is three things together rather than one. The claim grants it; every
 * write to the claimed row is fenced on it, so a handler that finishes after
 * its lease was taken updates nothing instead of releasing someone else's
 * claim; and {@link renewStageLease} lets a handler that expects to be slow
 * keep the claim alive, and tells it — by matching zero rows — when the claim
 * is already gone and its work should be dropped rather than written.
 */

import { child as childLogger } from '../../../log.ts';
import type { SqlStatement } from '../protocol.ts';
import { assetsDb, type SqliteDb } from './db-handle.ts';
import {
  STAGE_PARK_EXHAUSTED_SQL,
  STAGE_RENEW_LEASE_SQL,
  TAG_DAMAGED_SQL,
  stageClaimCandidatesSql,
  stageClaimSql,
} from './stage-runtime.sql.ts';

/**
 * How long a claim holds an asset before another claimer may take it.
 *
 * Long, deliberately: the ceiling is the slowest legitimate handler, not the
 * typical one. `describe` waits on a local Ollama model that may be loading
 * from cold, and `transcribe` runs the length of a video. A lease shorter than
 * the slowest handler would hand a still-running asset to a second worker,
 * which is the failure this whole mechanism exists to prevent; a lease longer
 * than necessary only delays recovery from a crash, and the attempt counter —
 * persisted at claim time — is what stops a poison asset cycling forever in
 * the meantime.
 */
export const CLAIM_LEASE_MS = 15 * 60_000;

/** One `dependsOn` entry, normalised. Mirrors `resolveStageDeps`' output. */
export interface ResolvedStageDep {
  name: string;
  minVersion: number;
}

/**
 * A stage's optional extra predicate, the SQLite spelling of
 * `StageConfig.claimFilter`.
 *
 * Without one, a stage claims from the whole unprocessed pool and skips the
 * assets it does not handle in its handler — which stamps a pointless skip
 * record on every non-matching asset and spends its concurrency slots on skip
 * work. `transcribe` and `video-describe` are the callers: both narrow to
 * `media_kind IN ('video', 'audio')`.
 *
 * The SQL is a fragment evaluated against a `stage_state` row, so anything
 * about the asset is an `EXISTS` over `assets` keyed on
 * `stage_state.asset_id`. It is AND-ed on, never merged, so it cannot collide
 * with a gate the claim already applies.
 */
export interface StageClaimResidual {
  sql: string;
  params: readonly (string | number)[];
}

/** One `stage_state` row as the candidate scan reads it. */
export interface StageStateRow {
  asset_id: string;
  version: number;
  attempts: number;
  last_error: string | null;
  processed_at: string | null;
  dead: number;
  failed_at: string | null;
  next_attempt_at: string | null;
}

/** The bookkeeping row a claim hands back, as the claim left it. */
export interface ClaimedStageRow extends StageStateRow {
  /** Already incremented by this claim — the attempt about to be made. */
  attempts: number;
  /**
   * The lease this claim stamped, never null. Every writeback for the attempt
   * is fenced on it, so the runner carries it from here into
   * `StageTarget.lease`.
   */
  next_attempt_at: string;
}

/** Everything the claim needs to know about the stage asking. */
export interface StageClaimRequest {
  stage: string;
  targetVersion: number;
  dependsOn: readonly ResolvedStageDep[];
  /** Assets this process is already running. Excluded from the candidate scan. */
  inFlight?: ReadonlySet<string>;
  residual?: StageClaimResidual;
  /** Claim batch size — `deriveBatchSize(concurrency)` at every call site. */
  limit: number;
  /** Attempts at which a row is taken to have been killed mid-handler. */
  maxAttempts: number;
  /**
   * `StageConfig.tagsDamagedOnDeadLetter`. A file-reading stage that parks an
   * asset as crash-exhausted tags the asset damaged in the same transaction,
   * so one poison RAW stops killing the process for every other stage in turn.
   */
  tagsDamagedOnDeadLetter?: boolean;
  now?: Date;
  leaseMs?: number;
}

/** What one tick of claiming produced. */
export interface StageClaimOutcome {
  /** Rows this caller won, with their state as the claim left it. */
  claimed: ClaimedStageRow[];
  /**
   * Rows parked as dead because their attempt budget was spent without the
   * row ever completing — an uncatchable native death mid-handler (#897).
   * Deliberately NOT dispatched, and already tagged damaged in the same
   * transaction when the stage tags on dead-letter. Reported so the runner can
   * log and count them, not as an obligation on the caller.
   */
  crashExhausted: Array<{ assetId: string; attempts: number; reason: string }>;
  /**
   * Candidates that were scanned but lost to a concurrent claimer. Zero on a
   * single-writer deployment; non-zero means two processes are claiming the
   * same stage, which is worth seeing in a log line rather than inferring from
   * a short batch.
   */
  contended: number;
}

const log = childLogger('sqlite:stage-claim');

/**
 * The parameters the candidate scan binds, in the order
 * {@link stageClaimCandidatesSql} lays its placeholders out.
 *
 * Built as one expression rather than by pushing onto an array through
 * successive `if`s, so the SQL fragment and its parameters cannot drift: each
 * clause the builder emits contributes its parameters at the same position
 * here.
 */
function candidateParams(request: StageClaimRequest, nowIso: string): Array<string | number> {
  const inFlight = request.inFlight ?? new Set<string>();
  return [
    request.stage,
    request.targetVersion,
    nowIso,
    ...request.dependsOn.flatMap((dep) => [dep.name, dep.minVersion]),
    ...inFlight,
    ...(request.residual?.params ?? []),
    request.limit,
  ];
}

/**
 * The parameters one claim binds, in {@link stageClaimSql}'s order.
 *
 * The tail is the scan's own dependency and residual parameters, because the
 * claim re-asks those gates too — the same list, minus the in-flight exclusion
 * and the limit, which are not part of the question the row itself answers.
 */
function claimParams(
  request: StageClaimRequest,
  row: StageStateRow,
  leaseUntil: string,
  nowIso: string,
): Array<string | number> {
  return [
    leaseUntil,
    row.asset_id,
    request.stage,
    request.targetVersion,
    nowIso,
    ...request.dependsOn.flatMap((dep) => [dep.name, dep.minVersion]),
    ...(request.residual?.params ?? []),
  ];
}

/**
 * The reason string a crash-exhausted row carries. Kept identical to the
 * Mongo runner's so an operator triaging the Workers dead-letter list sees the
 * same sentence before and after the cutover.
 */
function crashReason(attempts: number): string {
  return `claimed ${attempts}× without completing — worker aborted mid-handler (uncatchable native crash)`;
}

/**
 * Split the candidate batch into the rows to claim and the rows to park.
 *
 * Reconciliation reads no extra rows, and that is a deliberate correction
 * rather than a shortcut. `attempts` is not in `stage_claim` — the index
 * carries `stage, version, dead, next_attempt_at, asset_id` — so a separate
 * `WHERE attempts >= ?` sweep cannot be answered from the index and walks the
 * stage's whole backlog, reading a row body per candidate, on every poll tick
 * of every stage. Measured on 20,000 assets it made a claim 10.4 ms against
 * Mongo's 2.8 ms, which is the opposite of this port's entire argument. The
 * Mongo runner filters the batch it already fetched, and doing the same here
 * costs nothing: the candidates are in hand, with their attempt counts.
 */
function partitionCandidates(
  candidates: readonly StageStateRow[],
  maxAttempts: number,
): { claimable: StageStateRow[]; exhausted: StageClaimOutcome['crashExhausted'] } {
  return {
    claimable: candidates.filter((row) => row.attempts < maxAttempts),
    exhausted: candidates
      .filter((row) => row.attempts >= maxAttempts)
      .map((row) => ({
        assetId: row.asset_id,
        attempts: row.attempts,
        reason: crashReason(row.attempts),
      })),
  };
}

/**
 * Park one crash-exhausted row, and tag its asset damaged when the stage is a
 * damage-tagging one.
 *
 * The tag is what `reconcileCrashExhausted` does on Mongo, and leaving it out
 * would be the difference between a poison RAW that `abort()`s libraw being
 * parked once and it being claimed and killing the process again for `exif`,
 * `thumb`, `preview` and `describe` in turn. It goes in the claim's own
 * transaction rather than in a follow-up write, so the park and the tag cannot
 * come apart — which is better than the Mongo version, where they are two
 * independent `updateOne`s.
 */
function parkExhaustedStatements(
  request: StageClaimRequest,
  row: StageClaimOutcome['crashExhausted'][number],
  nowIso: string,
): SqlStatement[] {
  const park: SqlStatement = {
    sql: STAGE_PARK_EXHAUSTED_SQL,
    params: [row.reason, row.assetId, request.stage, request.maxAttempts, request.targetVersion],
  };
  if (request.tagsDamagedOnDeadLetter !== true) return [park];
  return [park, { sql: TAG_DAMAGED_SQL, params: [nowIso, request.stage, row.reason, row.assetId] }];
}

/**
 * Push a held claim's lease further out, for a handler that legitimately runs
 * longer than one lease.
 *
 * Returns the new lease when the claim is still this caller's, and `null` when
 * it is not — the row was re-claimed while the handler ran, and the work in
 * progress should be abandoned rather than written, because every writeback
 * for it is fenced on a lease that no longer exists.
 *
 * `lease` is the string the claim handed back in `next_attempt_at`, and the
 * return value replaces it for the next renewal and for the writeback.
 */
export async function renewStageLease(
  target: { assetId: string; stage: string; lease: string },
  options: { now?: Date; leaseMs?: number } = {},
  dbOverride?: SqliteDb,
): Promise<string | null> {
  const now = options.now ?? new Date();
  const renewed = new Date(now.getTime() + (options.leaseMs ?? CLAIM_LEASE_MS)).toISOString();
  const result = await assetsDb(dbOverride).write(STAGE_RENEW_LEASE_SQL, [
    renewed,
    target.assetId,
    target.stage,
    target.lease,
  ]);
  if (result.changes > 0) return renewed;
  log.warn(
    { stage: target.stage, assetId: target.assetId },
    `${target.stage}: lease lost while the handler was still running`,
  );
  return null;
}

/**
 * Claim up to `limit` assets for one stage.
 *
 * Three steps, and the middle one is the whole point.
 *
 *  1. Scan the `stage_claim` index for candidates. A read, so it runs on a
 *     reader worker and never queues behind a write.
 *  2. Take them, in one transaction, one `UPDATE` per candidate — alongside the
 *     mark-dead for any candidate whose budget was already spent. Each claim
 *     statement re-asks the gates the scan asked; the ones that still hold are
 *     this caller's, and `changes` says which.
 *  3. Return the rows that were won, carrying the state the claim wrote — so
 *     the caller knows the attempt number it is about to make without a second
 *     read.
 *
 * The candidate scan being a separate, un-locked read is deliberate. It is the
 * expensive half (a range scan) and it does not need to be exclusive: a stale
 * candidate simply loses at step 2. Taking the write lock for the scan as well
 * would serialise every stage's poll tick against every other stage's, on a
 * single-writer database, for no correctness gain.
 *
 * A batch that is all crash-exhausted rows therefore claims nothing this tick
 * and drains a batch at a time, which is exactly what the Mongo runner does —
 * and the point of not re-dispatching them, since one poison asset re-claiming
 * on every respawn is how a whole tier stops draining (#897).
 */
export async function claimStageBatch(
  request: StageClaimRequest,
  dbOverride?: SqliteDb,
): Promise<StageClaimOutcome> {
  const db = assetsDb(dbOverride);
  const now = request.now ?? new Date();
  const nowIso = now.toISOString();

  const sql = stageClaimCandidatesSql(
    request.dependsOn.length,
    request.inFlight?.size ?? 0,
    request.residual?.sql,
  );
  const candidates = await db.read<StageStateRow>(sql, candidateParams(request, nowIso));
  if (candidates.length === 0) return { claimed: [], crashExhausted: [], contended: 0 };

  const { claimable, exhausted } = partitionCandidates(candidates, request.maxAttempts);
  const leaseUntil = new Date(now.getTime() + (request.leaseMs ?? CLAIM_LEASE_MS)).toISOString();
  const parkStatements = exhausted.flatMap((row) => parkExhaustedStatements(request, row, nowIso));
  const claimSql = stageClaimSql(request.dependsOn.length, request.residual?.sql);
  const results = await db.transaction([
    ...parkStatements,
    ...claimable.map(
      (row): SqlStatement => ({
        sql: claimSql,
        params: claimParams(request, row, leaseUntil, nowIso),
      }),
    ),
  ]);

  const claimed = claimable
    // The claim statements start after the crash-exhaustion parks in the batch.
    .filter((_, index) => (results[parkStatements.length + index]?.changes ?? 0) > 0)
    // The row as the claim left it: the attempt is spent and the lease is on.
    .map(
      (row): ClaimedStageRow => ({
        ...row,
        attempts: row.attempts + 1,
        next_attempt_at: leaseUntil,
      }),
    );
  const contended = claimable.length - claimed.length;
  if (exhausted.length > 0) {
    log.warn(
      { stage: request.stage, count: exhausted.length },
      `${request.stage}: parked crash-exhausted assets`,
    );
  }
  if (contended > 0) {
    log.info(
      { stage: request.stage, contended, claimed: claimed.length },
      `${request.stage}: candidates lost to a concurrent claimer`,
    );
  }
  return { claimed, crashExhausted: exhausted, contended };
}
