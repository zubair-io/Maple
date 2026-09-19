/**
 * One poll tick: claim a batch, run its handlers, record what they did.
 *
 * Split out of `run-stage.ts` at the SQLite cutover (#3787), which is when the
 * tick stopped being "a `find`, then an `updateOne` per asset per event" and
 * became three phases with a clear boundary between them:
 *
 *  1. **Claim.** `claimStageBatch` takes up to `5 × concurrency` rows in one
 *     transaction and hands back each one's attempt number and lease. It also
 *     parks the rows whose attempt budget was spent without them ever
 *     completing — an uncatchable native death mid-handler (#897) — and those
 *     are deliberately not dispatched.
 *  2. **Dispatch.** The claimed assets' documents are loaded in one batch and
 *     run through the same bounded worker pool as before.
 *  3. **Writeback.** Each handler's statements go into a `StageWritebackBatch`
 *     and the whole tick commits as one `BEGIN IMMEDIATE`, with a per-result
 *     retry so one bad asset cannot cost the other nineteen their bookkeeping.
 *
 * ## Why the batch is bounded, and must stay so
 *
 * After boot the API process and the worker child both hold writer connections
 * to the same file. SQLite's file locks arbitrate between them with a busy
 * timeout and a retry ladder, and that is only safe while no transaction is
 * long. So the writeback commits per batch — never once per stage run, and
 * never wrapped around the handlers themselves, which can take minutes.
 *
 * ## Every write to a claimed row carries its lease
 *
 * `StageTarget.lease` is the string the claim stamped, and the writeback
 * statements are all fenced on it. A handler that outran `CLAIM_LEASE_MS` has
 * already lost its asset to a second claimer, so its writeback matches zero
 * rows rather than releasing a claim it no longer holds.
 */

import * as path from 'node:path';
import { child as childLogger } from '../log.ts';
import { assetAbsPath, assetPrimaryFileInfo, isEnoentError } from '../indexer/images.repo.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import { loadLibraries } from '../db/sqlite/repos/assets.read.ts';
import { assetsDb, type SqliteDb } from '../db/sqlite/repos/db-handle.ts';
import {
  claimStageBatch,
  type ClaimedStageRow,
  type ResolvedStageDep,
} from '../db/sqlite/repos/stage-claim.ts';
import { loadStageDocuments } from '../db/sqlite/repos/stage-documents.repo.ts';
import { StageWritebackBatch } from '../db/sqlite/repos/stage-writeback.batch.ts';
import {
  claimRollbackStatement,
  stageFailureStatements,
  stageResultStatements,
  tagDamagedStatement,
  tagLocationMissingByAddressStatement,
  type StageTarget,
} from '../db/sqlite/repos/stage-writeback.ts';
import { deriveBatchSize, retryDelayMs } from './loop-policy.ts';
import { libraryRootAvailable, statKind } from './missing-reaper.helpers.ts';
import { dispatchPool } from './dispatch-pool.ts';
import { resolveStageDeps } from './stage-config.ts';
import type { ImageDoc, StageConfig, StageContext, WorkerConfig } from './stage-config.ts';
import type { ThroughputWindow } from './throughput-window.ts';

/** Cap a stored error so a verbose decoder dump cannot bloat the row or the log. */
const MAX_REASON_LEN = 500;

function trimReason(reason: string): string {
  return reason.length > MAX_REASON_LEN ? `${reason.slice(0, MAX_REASON_LEN)}…` : reason;
}

/** Everything one tick shares across its assets, assembled once. */
interface TickContext {
  stage: StageConfig;
  config: WorkerConfig;
  ctx: StageContext;
  deps: readonly ResolvedStageDep[];
  docs: ReadonlyMap<string, ImageDoc>;
  libraries: ReadonlyMap<string, string>;
  batch: StageWritebackBatch;
  throughput?: ThroughputWindow;
}

/**
 * Publish an update onto the change feed for an asset a handler just wrote.
 *
 * Best-effort — failures are swallowed; the change feed tolerates gaps. The
 * library roots come from the tick's own read rather than from the indexer's
 * process-wide cache, so this path holds no Mongo dependency of its own.
 */
async function publishUpdate(doc: ImageDoc, libraries: ReadonlyMap<string, string>): Promise<void> {
  const primary = assetPrimaryFileInfo(doc);
  await recordAndPublishAssetChange({
    kind: 'update',
    asset_id: doc._id,
    folder_id: primary?.library_id ?? null,
    abs_path: assetAbsPath(doc, libraries),
  }).catch(() => {});
}

/**
 * Confirm-before-tag (#2171): a handler-level ENOENT is only a CLAIM that the
 * file is gone — it can also be a race (file mid-move), a stale negative cache
 * on a network share, or an unmounted library root, under which every child
 * path ENOENTs. Before stamping `missing_since`, require that the root is
 * available and that a fresh re-stat of the exact path confirms the absence.
 *
 * Anything else refuses the tag; the claim rollback leaves the row claimable,
 * so a transient blip just retries on a later poll.
 */
async function confirmMissing(
  entry: { library_id: { toHexString(): string }; path: string; filename: string },
  libraries: ReadonlyMap<string, string>,
): Promise<boolean> {
  const root = libraries.get(entry.library_id.toHexString());
  if (root === undefined || root === '') return false;
  if (!(await libraryRootAvailable(root))) return false;
  const segments = entry.path === '' ? [] : entry.path.split('/');
  return (await statKind(path.join(root, ...segments, entry.filename))) === 'absent';
}

/**
 * The ENOENT path: hand the claim back without spending the attempt, and tag
 * the location the handler failed to read so the missing-reaper resolves it.
 *
 * The attempt is rolled back because a missing original was never genuinely
 * attempted — it is parked for the reaper by the tag, which drops the asset out
 * of every stage's claim as soon as it was its last live location.
 */
async function recordMissingOriginal(
  tick: TickContext,
  target: StageTarget,
  doc: ImageDoc,
): Promise<void> {
  const primary = assetPrimaryFileInfo(doc);
  const confirmed = primary !== null && (await confirmMissing(primary, tick.libraries));
  const reason = `stage-enoent:${tick.stage.name}`;
  await tick.batch.record(
    confirmed && primary !== null
      ? [
          claimRollbackStatement(target),
          tagLocationMissingByAddressStatement(
            target.assetId,
            {
              libraryId: primary.library_id.toHexString(),
              path: primary.path,
              filename: primary.filename,
            },
            reason,
          ),
        ]
      : [claimRollbackStatement(target)],
    target.assetId,
  );
  if (confirmed) {
    tick.ctx.log.debug({ _id: target.assetId }, `${tick.stage.name}: original missing — tagged`);
    return;
  }
  tick.ctx.log.warn(
    { _id: target.assetId },
    `${tick.stage.name}: ENOENT not confirmed (root unavailable or file present) — will retry`,
  );
}

/**
 * A handler that threw: the failure bookkeeping, the retry gate, and — for a
 * file-reading stage that just ran out of attempts — the `damaged` tag that
 * parks the asset out of every other stage rather than letting each one grind
 * to its own dead-letter on the same unreadable bytes.
 */
async function recordFailure(
  tick: TickContext,
  target: StageTarget,
  attemptNo: number,
  err: unknown,
): Promise<void> {
  const outcome = stageFailureStatements({
    target,
    attemptNo,
    maxAttempts: tick.config.maxAttempts,
    err,
    retryDelayMs,
  });
  const reason = trimReason(outcome.message);
  const tag =
    outcome.dead && tick.stage.tagsDamagedOnDeadLetter === true
      ? [tagDamagedStatement(target.assetId, tick.stage.name, reason)]
      : [];
  await tick.batch.record([...outcome.statements, ...tag], target.assetId);

  const fields = {
    _id: target.assetId,
    stage: tick.stage.name,
    attempt: attemptNo,
    maxAttempts: tick.config.maxAttempts,
    retryable: !outcome.terminal,
    retryInMs: outcome.retryInMs,
    err: outcome.message,
  };
  if (outcome.dead) {
    tick.ctx.log.error(fields, `${tick.stage.name}: dead-lettered after ${attemptNo} attempt(s)`);
    if (tag.length > 0) {
      tick.ctx.log.warn(
        { event: 'asset.damaged', asset_id: target.assetId, stage: tick.stage.name, reason },
        `asset ${target.assetId} tagged damaged by ${tick.stage.name}: ${reason}`,
      );
    }
    return;
  }
  tick.ctx.log.warn(fields, `${tick.stage.name}: attempt ${attemptNo} failed, will retry`);
}

/** Run one claimed asset's handler and queue whatever it decided. */
async function runClaimedAsset(tick: TickContext, row: ClaimedStageRow): Promise<void> {
  const doc = tick.docs.get(row.asset_id);
  // Hard-deleted between the claim and the load. Its `stage_state` row went
  // with it (the foreign key cascades), so there is nothing to hand back.
  if (doc === undefined) return;

  const target: StageTarget = {
    assetId: row.asset_id,
    stage: tick.stage.name,
    targetVersion: tick.stage.targetVersion,
    lease: row.next_attempt_at,
  };
  try {
    const result = await tick.stage.handler(doc, tick.ctx);
    await tick.batch.record(
      stageResultStatements(
        {
          target,
          attemptNo: row.attempts,
          maxAttempts: tick.config.maxAttempts,
          dependsOn: tick.deps.map((dep) => dep.name),
          tagsDamagedOnDeadLetter: tick.stage.tagsDamagedOnDeadLetter,
        },
        result,
      ),
      row.asset_id,
    );
    if ('patch' in result || 'wrote' in result) await publishUpdate(doc, tick.libraries);
    tick.throughput?.record(new Date());
  } catch (err) {
    if (tick.stage.tagsMissingOnEnoent === true && isEnoentError(err)) {
      await recordMissingOriginal(tick, target, doc);
      return;
    }
    await recordFailure(tick, target, row.attempts, err);
  }
}

/**
 * One poll tick. Returns how many rows the claim touched — the dispatched ones
 * plus the crash-exhausted ones it parked — which is what the poll loop
 * compares against the batch size to decide whether to re-poll immediately.
 *
 * Counting the parked rows matters: a batch that is entirely poison drains a
 * batch at a time, and reporting zero would put the loop back to its idle
 * cadence and stretch that drain out over minutes.
 */
export async function runOnce(
  stage: StageConfig,
  config: WorkerConfig,
  resolvedDeps: readonly ResolvedStageDep[] = resolveStageDeps(stage.dependsOn),
  signal?: AbortSignal,
  inFlightSet?: Set<string>,
  throughput?: ThroughputWindow,
  dbOverride?: SqliteDb,
): Promise<number> {
  if (config.paused) return 0;

  const db = assetsDb(dbOverride);
  const log = childLogger(`workers:${stage.name}`);
  const ctx: StageContext = { log, signal: signal ?? new AbortController().signal };

  const outcome = await claimStageBatch(
    {
      stage: stage.name,
      targetVersion: stage.targetVersion,
      dependsOn: resolvedDeps,
      inFlight: inFlightSet,
      residual: stage.claimResidual,
      // Derived (5× concurrency), not a knob. With the re-poll-on-full-batch
      // loop this only governs round-trip efficiency.
      limit: deriveBatchSize(config.concurrency),
      maxAttempts: config.maxAttempts,
      tagsDamagedOnDeadLetter: stage.tagsDamagedOnDeadLetter,
    },
    db,
  );
  if (outcome.claimed.length === 0) return outcome.crashExhausted.length;

  const ids = outcome.claimed.map((row) => row.asset_id);
  const [docs, libraries] = await Promise.all([loadStageDocuments(ids, db), loadLibraries(db)]);
  const tick: TickContext = {
    stage,
    config,
    ctx,
    deps: resolvedDeps,
    docs,
    libraries,
    batch: new StageWritebackBatch(db),
    throughput,
  };

  await dispatchPool([...outcome.claimed], config.concurrency, async (row) => {
    inFlightSet?.add(row.asset_id);
    try {
      await runClaimedAsset(tick, row);
    } finally {
      inFlightSet?.delete(row.asset_id);
    }
  });

  const dropped = await tick.batch.flush();
  if (dropped.length > 0) {
    log.error(
      { stage: stage.name, dropped: dropped.length },
      `${stage.name}: writebacks dropped — those assets re-run when their lease expires`,
    );
  }
  return outcome.claimed.length + outcome.crashExhausted.length;
}
