/**
 * What one Temporal activity attempt looks like to the code running a row: an
 * identity that fences its writes, a heartbeat, and why the engine wants it to
 * stop. Jobs and imports build their attempt here so both stop for the same
 * reasons.
 */

import { randomUUID } from 'node:crypto';
import { ApplicationFailure, Context } from '@temporalio/activity';
import type { RowRun } from './row-workflow.ts';

/** Why the engine wants an attempt to stop: a cancel, or an operator pausing or resetting it. */
export type AttemptStop = 'cancel' | 'superseded';

export interface RowAttempt {
  /**
   * `temporal:<workflow run id>:<activity id>:<attempt number>:<nonce>`; every
   * write the attempt makes is fenced to it. The nonce is what makes it unique
   * per delivery: resetting an activity in Temporal starts its attempt count
   * again, so the other parts can repeat while the earlier delivery still runs.
   */
  identity: string;
  heartbeat: (progress: { current: number; total: number }) => void;
  stopReason: () => AttemptStop | null;
}

/** Raised to the engine so it can redeliver; the row is left for that later attempt. */
export class AttemptSuperseded extends Error {
  override name = 'AttemptSuperseded';
  constructor() {
    super('The attempt was paused or reset in Temporal');
  }
}

/**
 * Rows are never deleted, so a dispatch for a row this database has never seen
 * came from another Maple server working in the same Temporal namespace.
 */
export class UnknownRowError extends Error {
  override name = 'UnknownRowError';
  constructor(subject: string) {
    super(
      `${subject} is not in this server's database. Each Maple server needs its own Temporal namespace.`,
    );
  }
}

/** A delivery for a row that already finished reports how it finished and runs nothing. */
export function finishedRun(
  subject: string,
  row: { status: string; error?: string | null } | null,
): RowRun {
  if (row === null) throw new UnknownRowError(subject);
  if (row.status === 'done' || row.status === 'cancelled') return { outcome: row.status };
  return { outcome: 'failed', error: row.error ?? `${subject} failed` };
}

/**
 * Only three things stop a handler: a cancel, and an operator pausing or
 * resetting the activity. A worker shutting down does not, and neither does
 * Temporal giving up on the attempt after losing contact with it. A healthy
 * handler finishes its row either way; if it is in fact gone, the attempt
 * Temporal sends next takes the row over and the fence stops this one.
 */
export function attemptStop(details: Context['cancellationDetails']): AttemptStop | null {
  if (details === undefined) return null;
  if (details.cancelRequested) return 'cancel';
  return details.paused || details.reset ? 'superseded' : null;
}

/** Runs `work` as the current activity attempt; a row from another database fails for good. */
export async function runAttempt(work: (attempt: RowAttempt) => Promise<RowRun>): Promise<RowRun> {
  const context = Context.current();
  const { workflowExecution, activityId, attempt } = context.info;
  try {
    return await work({
      identity: `temporal:${workflowExecution?.runId}:${activityId}:${attempt}:${randomUUID()}`,
      heartbeat: (progress) => context.heartbeat(progress),
      stopReason: () => attemptStop(context.cancellationDetails),
    });
  } catch (error) {
    if (error instanceof UnknownRowError) throw ApplicationFailure.nonRetryable(error.message);
    throw error;
  }
}
