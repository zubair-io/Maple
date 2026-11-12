/**
 * Runs one job for one activity attempt: claim the row, hand it to its handler,
 * record how it ended. Temporal decides when this is called and whether it is
 * called again; nothing here polls.
 */

import { ObjectId } from '../db/object-id.ts';
import {
  claimJob,
  completeJob,
  failJob,
  getJob,
  isCancelRequested,
  markCancelled,
  saveJobCheckpoint,
  updateProgress,
} from './jobs.repo.ts';
import { HANDLERS, type JobHandler, type JobHandlerContext } from './handlers/index.ts';
import { AttemptSuperseded, finishedRun, type RowAttempt } from '../temporal/activity-attempt.ts';
import type { RowRun } from '../temporal/row-workflow.ts';

/** Well inside the five-minute heartbeat timeout of `ROW_ACTIVITY_OPTIONS`. */
const RENEW_EVERY_MS_DEFAULT = 100_000;

export interface ExecuteJobOptions {
  handlers?: Partial<Record<string, JobHandler>>;
  /** How often a running job re-checks its claim and heartbeats while its handler reports nothing. */
  renewEveryMs?: number;
  now?: () => Date;
}

type Claim = NonNullable<Awaited<ReturnType<typeof claimJob>>>;

interface AttemptRun {
  claim: Claim;
  attempt: RowAttempt;
  renewEveryMs: number;
  now: () => Date;
}

/** A long native render reports nothing for minutes, so the claim is re-checked
 * and the engine heartbeaten on a timer rather than on handler progress. */
async function runHandler(run: AttemptRun, handler: JobHandler) {
  const { claim, attempt, renewEveryMs, now } = run;
  let progress = claim.progress;
  let claimError: Error | null = null;
  let renewal: Promise<void> | null = null;
  const check = () => {
    if (attempt.stopReason() === 'superseded') throw new AttemptSuperseded();
    if (claimError) throw new Error(claimError.message, { cause: claimError });
  };
  const renew = async () => {
    await updateProgress(claim._id, progress, now, attempt.identity);
    attempt.heartbeat(progress);
  };
  const timer = setInterval(() => {
    if (renewal || claimError) return;
    renewal = renew()
      .catch((error: unknown) => {
        claimError = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        renewal = null;
      });
  }, renewEveryMs);
  const ctx: JobHandlerContext = {
    jobId: claim._id,
    checkpoint: claim.checkpoint,
    saveCheckpoint: async (checkpoint, entryIndex) => {
      check();
      await saveJobCheckpoint(claim._id, attempt.identity, checkpoint, now, entryIndex);
    },
    reportProgress: async (current, total) => {
      check();
      progress = { current, total };
      await renew();
    },
    shouldCancel: async () => {
      check();
      // A cancel made in Temporal only arrives on a heartbeat reply.
      attempt.heartbeat(progress);
      return attempt.stopReason() === 'cancel' || isCancelRequested(claim._id);
    },
  };
  try {
    const result = await handler.run(claim.payload, ctx);
    check();
    return result;
  } finally {
    clearInterval(timer);
    await renewal;
    check();
  }
}

export async function executeJob(
  jobId: string,
  attempt: RowAttempt,
  options: ExecuteJobOptions = {},
): Promise<RowRun> {
  const renewEveryMs = options.renewEveryMs ?? RENEW_EVERY_MS_DEFAULT;
  const now = options.now ?? (() => new Date());
  const handlers = options.handlers ?? HANDLERS;

  const id = new ObjectId(jobId);
  const claim = await claimJob(id, attempt.identity, now);
  if (!claim) return finishedRun(`Job ${jobId}`, await getJob(id));
  attempt.heartbeat(claim.progress);

  const fail = async (error: string): Promise<RowRun> => {
    await failJob(claim._id, error, now, attempt.identity);
    return { outcome: 'failed', error };
  };

  const handler = handlers[claim.kind];
  if (!handler) return fail(`no handler registered for kind: ${claim.kind}`);

  try {
    const out = await runHandler({ claim, attempt, renewEveryMs, now }, handler);
    if (out.kind === 'cancelled') {
      await markCancelled(claim._id, out.result ?? null, now, attempt.identity);
      return { outcome: 'cancelled' };
    }
    await completeJob(claim._id, out.result, now, attempt.identity);
    return { outcome: 'done' };
  } catch (err) {
    if (err instanceof AttemptSuperseded) throw err;
    return fail(err instanceof Error ? err.message : String(err));
  }
}
