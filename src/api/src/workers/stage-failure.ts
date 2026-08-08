/**
 * Failure bookkeeping for a stage handler that threw.
 *
 * Extracted from `run-stage.ts` when the retry-backoff work (#2729) pushed
 * that file past the 600-line hard budget. The seam is a real one: everything
 * here answers a single question — given an attempt that failed, what do we
 * record and when may it run again — independently of the claim/dispatch
 * machinery around it, and it is the part with the most policy in it.
 *
 * Two behaviours this owns are worth stating up front, because both were
 * absent before and both caused real incidents:
 *
 *   - **Retry backoff.** A failed attempt used to be eligible again on the
 *     very next poll tick, so consecutive attempts landed milliseconds apart
 *     and the attempt budget bought nothing against the failures it exists
 *     for. With prod's `describe.maxAttempts: 2`, a one-second provider blip
 *     permanently dead-lettered an asset, and "Retry dead" walked straight
 *     into the same wall (#2728, #2729).
 *   - **Logging.** This path wrote to Mongo and logged nothing, so a
 *     dead-lettered asset was visible in the Workers UI and completely absent
 *     from SigNoz — which reads as "the error isn't real" during triage
 *     (#2730).
 */

import type { Collection, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import { retryDelayMs } from './loop-policy.ts';
import type { ImageDoc } from './stage-config.ts';
import { tagDamaged } from './tag-damaged.ts';

export interface StageFailureInput {
  images: Collection<ImageDoc>;
  id: ObjectId;
  /** Hex id, for the log line. */
  idStr: string;
  stageName: string;
  /** Attempt number that just failed, 1-based and already persisted. */
  attemptNo: number;
  maxAttempts: number;
  err: unknown;
  log: Logger;
}

export interface StageFailureOutcome {
  /** True when the asset is now dead-lettered and will not be re-claimed. */
  dead: boolean;
  /** The message written to `last_error`. */
  message: string;
}

/**
 * Does an error assert that retrying is pointless?
 *
 * Read structurally rather than via `instanceof RemoteError`: that class lives
 * under `enrichment/describe-providers/`, and the generic stage runner
 * importing from one stage's provider tree would invert the dependency for
 * every other stage. Any error declaring a boolean `retryable` participates.
 *
 * Only an explicit `false` counts. An error that doesn't carry the flag says
 * nothing about retryability, so it keeps its full attempt budget.
 */
function isTerminalError(err: unknown): boolean {
  return (err as { retryable?: unknown } | null | undefined)?.retryable === false;
}

/**
 * Persist the outcome of a failed attempt and log it.
 *
 * `attempts` was already written at claim time (so an uncatchable native death
 * still counts), which is why `dead` is computed from `attemptNo` rather than
 * re-reading or re-incrementing.
 *
 * A terminal error dead-letters immediately instead of spending the remaining
 * budget: a 4xx means the request itself is wrong, so walking the rest of the
 * backoff ladder cannot produce a different answer — it only delays the
 * dead-letter by the length of the ladder.
 */
export async function recordStageFailure(input: StageFailureInput): Promise<StageFailureOutcome> {
  const { images, id, idStr, stageName, attemptNo, maxAttempts, err, log } = input;
  const message = err instanceof Error ? err.message : String(err);

  const terminal = isTerminalError(err);
  const dead = terminal || attemptNo >= maxAttempts;
  const failedAt = new Date();
  const retryDelay = dead ? null : retryDelayMs(attemptNo);
  const stageKey = `stages.${stageName}`;

  await images.updateOne(
    { _id: id },
    {
      $set: {
        [`${stageKey}.last_error`]: message,
        [`${stageKey}.dead`]: dead,
        // `failed_at` is what makes `last_error` datable — without it a stale
        // string is indistinguishable from a live failure, and neither can be
        // correlated against provider logs, deploys or restarts (#2730).
        [`${stageKey}.failed_at`]: failedAt,
        [`${stageKey}.next_attempt_at`]:
          retryDelay === null ? null : new Date(failedAt.getTime() + retryDelay),
      },
    },
  );

  // Structured so the pino→OTel bridge carries the fields worth alerting and
  // grouping on, the way `tagDamaged` already does.
  const fields = {
    _id: idStr,
    stage: stageName,
    attempt: attemptNo,
    maxAttempts,
    retryable: !terminal,
    retryInMs: retryDelay,
    err: message,
  };
  if (dead) {
    log.error(fields, `${stageName}: dead-lettered after ${attemptNo} attempt(s)`);
  } else {
    log.warn(fields, `${stageName}: attempt ${attemptNo} failed, will retry`);
  }

  return { dead, message };
}

/**
 * Dead-letter assets whose attempt budget was consumed by uncatchable deaths.
 *
 * The worker tier runs native code (onnx, libraw, sharp) that can `abort()`
 * the whole process mid-handler — a death `recordStageFailure` never observes,
 * because nothing catches it. A doc whose `attempts` reached `maxAttempts` but
 * was never marked done OR dead can only have got there that way: a normal
 * throw would have dead-lettered it in the catch.
 *
 * Reconcile those here, at claim time, and do NOT re-dispatch them — otherwise
 * a single poison asset re-claims on every respawn forever and the whole tier
 * never drains (#897).
 *
 * Deliberately no retry gate: these rows are terminal, and a `next_attempt_at`
 * on a dead row would be meaningless.
 */
export async function reconcileCrashExhausted(input: {
  images: Collection<ImageDoc>;
  docs: ImageDoc[];
  stage: { name: string; tagsDamagedOnDeadLetter?: boolean };
  maxAttempts: number;
  priorAttempts: (d: ImageDoc) => number;
}): Promise<void> {
  const { images, docs, stage, maxAttempts, priorAttempts } = input;
  const stageKey = `stages.${stage.name}`;

  for (const doc of docs.filter((d) => priorAttempts(d) >= maxAttempts)) {
    const id = (doc as { _id: ObjectId })._id;
    const reason = `claimed ${priorAttempts(doc)}× without completing — worker aborted mid-handler (uncatchable native crash)`;
    await images.updateOne(
      { _id: id },
      { $set: { [`${stageKey}.dead`]: true, [`${stageKey}.last_error`]: reason } },
    );
    if (stage.tagsDamagedOnDeadLetter) await tagDamaged(images, id, stage.name, reason);
  }
}
