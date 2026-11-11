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

const LEASE_MS_DEFAULT = 5 * 60 * 1_000;

/** Why the engine wants an attempt to stop: a cancel, or an operator pausing or resetting it. */
export type AttemptStop = 'cancel' | 'superseded';

export interface JobAttempt {
  /** Unique per delivery; every write the attempt makes is fenced to it. */
  identity: string;
  heartbeat: (progress: { current: number; total: number }) => void;
  stopReason: () => AttemptStop | null;
}

export interface ExecuteJobOptions {
  handlers?: Partial<Record<string, JobHandler>>;
  /** The claim is renewed, and the engine heartbeaten, every third of this. */
  leaseMs?: number;
  now?: () => Date;
}

/** How the job stands once an attempt returns. */
export type JobRun = { outcome: 'done' | 'cancelled' } | { outcome: 'failed'; error: string };

/** Raised to the engine so it can redeliver; the job row is left for that later attempt. */
export class JobAttemptSuperseded extends Error {
  override name = 'JobAttemptSuperseded';
  constructor() {
    super('The attempt was paused or reset in Temporal');
  }
}

/**
 * Job rows are never deleted, so a dispatch for a job this database has never
 * seen came from another Maple server working in the same Temporal namespace.
 */
export class UnknownJobError extends Error {
  override name = 'UnknownJobError';
  constructor(jobId: string) {
    super(
      `Job ${jobId} is not in this server's database. Each Maple server needs its own Temporal namespace.`,
    );
  }
}

/** A delivery for a job that already finished reports how it finished and runs nothing. */
function finishedRun(jobId: string, job: Awaited<ReturnType<typeof getJob>>): JobRun {
  if (job === null) throw new UnknownJobError(jobId);
  if (job.status === 'done' || job.status === 'cancelled') return { outcome: job.status };
  return { outcome: 'failed', error: job.error ?? 'The job failed' };
}

type Claim = NonNullable<Awaited<ReturnType<typeof claimJob>>>;

interface AttemptRun {
  claim: Claim;
  attempt: JobAttempt;
  leaseMs: number;
  now: () => Date;
}

/** A long native render reports nothing for minutes, so the claim and the
 * engine's heartbeat are renewed on a timer rather than on handler progress. */
async function runHandler(run: AttemptRun, handler: JobHandler) {
  const { claim, attempt, leaseMs, now } = run;
  let progress = claim.progress;
  let leaseError: Error | null = null;
  let renewal: Promise<void> | null = null;
  const check = () => {
    if (attempt.stopReason() === 'superseded') throw new JobAttemptSuperseded();
    if (leaseError) throw new Error(leaseError.message, { cause: leaseError });
  };
  const renew = async () => {
    await updateProgress(claim._id, progress, leaseMs, now, attempt.identity);
    attempt.heartbeat(progress);
  };
  const timer = setInterval(
    () => {
      if (renewal || leaseError) return;
      renewal = renew()
        .catch((error: unknown) => {
          leaseError = error instanceof Error ? error : new Error(String(error));
        })
        .finally(() => {
          renewal = null;
        });
    },
    Math.max(1, Math.floor(leaseMs / 3)),
  );
  const ctx: JobHandlerContext = {
    jobId: claim._id,
    checkpoint: claim.checkpoint,
    saveCheckpoint: async (checkpoint, entryIndex) => {
      check();
      await saveJobCheckpoint(claim._id, attempt.identity, checkpoint, leaseMs, now, entryIndex);
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
  attempt: JobAttempt,
  options: ExecuteJobOptions = {},
): Promise<JobRun> {
  const leaseMs = options.leaseMs ?? LEASE_MS_DEFAULT;
  const now = options.now ?? (() => new Date());
  const handlers = options.handlers ?? HANDLERS;

  const id = new ObjectId(jobId);
  const claim = await claimJob(id, attempt.identity, leaseMs, now);
  if (!claim) return finishedRun(jobId, await getJob(id));
  attempt.heartbeat(claim.progress);

  const fail = async (error: string): Promise<JobRun> => {
    await failJob(claim._id, error, now, attempt.identity);
    return { outcome: 'failed', error };
  };

  const handler = handlers[claim.kind];
  if (!handler) return fail(`no handler registered for kind: ${claim.kind}`);

  try {
    const out = await runHandler({ claim, attempt, leaseMs, now }, handler);
    if (out.kind === 'cancelled') {
      await markCancelled(claim._id, out.result ?? null, now, attempt.identity);
      return { outcome: 'cancelled' };
    }
    await completeJob(claim._id, out.result, now, attempt.identity);
    return { outcome: 'done' };
  } catch (err) {
    if (err instanceof JobAttemptSuperseded) throw err;
    return fail(err instanceof Error ? err.message : String(err));
  }
}
