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
 */

import { child as childLogger } from '../../../log.ts';
import type { SqlStatement } from '../protocol.ts';
import { assetsDb, type SqliteDb } from './db-handle.ts';
import {
  STAGE_CLAIM_SQL,
  STAGE_MARK_DEAD_SQL,
  stageClaimCandidatesSql,
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

/** The bookkeeping row a claim hands back, as stored. */
export interface ClaimedStageRow {
  asset_id: string;
  version: number;
  /** Already incremented by this claim — the attempt about to be made. */
  attempts: number;
  last_error: string | null;
  processed_at: string | null;
  dead: number;
  failed_at: string | null;
  next_attempt_at: string | null;
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
   * Deliberately NOT dispatched; a stage that tags damaged on dead-letter
   * should tag these, which is why they are reported rather than swallowed.
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
  candidates: readonly ClaimedStageRow[],
  maxAttempts: number,
): { claimable: ClaimedStageRow[]; exhausted: StageClaimOutcome['crashExhausted'] } {
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
  const candidates = await db.read<ClaimedStageRow>(sql, candidateParams(request, nowIso));
  if (candidates.length === 0) return { claimed: [], crashExhausted: [], contended: 0 };

  const { claimable, exhausted } = partitionCandidates(candidates, request.maxAttempts);
  const leaseUntil = new Date(now.getTime() + (request.leaseMs ?? CLAIM_LEASE_MS)).toISOString();
  const results = await db.transaction([
    ...exhausted.map(
      (row): SqlStatement => ({
        sql: STAGE_MARK_DEAD_SQL,
        params: [row.reason, row.assetId, request.stage],
      }),
    ),
    ...claimable.map(
      (row): SqlStatement => ({
        sql: STAGE_CLAIM_SQL,
        params: [leaseUntil, row.asset_id, request.stage, request.targetVersion, nowIso],
      }),
    ),
  ]);

  const claimed = claimable
    // The claim statements start after the mark-dead ones in the same batch.
    .filter((_, index) => (results[exhausted.length + index]?.changes ?? 0) > 0)
    // The row as the claim left it: the attempt is spent and the lease is on.
    .map((row) => ({ ...row, attempts: row.attempts + 1, next_attempt_at: leaseUntil }));
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
