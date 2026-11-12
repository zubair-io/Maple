/**
 * How a route starts an operator one-shot and, for the routes that answer with
 * its outcome, waits for it. The route only writes the row; the operations lane
 * in the worker tier runs it (`operation-queue.ts`).
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { ObjectId } from '../db/object-id.ts';
import { activeOperationId } from '../db/repos/operations.repo.ts';
import type { JobWithId, OperationKind } from '../db/schema.ts';
import { createJob, getJob, JobConflictError, operationFolderId } from './jobs.repo.ts';

export interface StartedOperation {
  job: JobWithId;
  /** True when one was already active and the request joined it instead. */
  joined: boolean;
}

/**
 * Creates the operation, or answers with the one already active in its place:
 * the insert refuses a second active operation of a kind (per folder, for a
 * scan). One that finishes between the refusal and the lookup leaves room for
 * this one, so the insert is tried again.
 */
export async function startOperation(
  kind: OperationKind,
  payload: Record<string, unknown>,
): Promise<StartedOperation> {
  try {
    return { job: await createJob({ kind, payload }), joined: false };
  } catch (error) {
    if (!(error instanceof JobConflictError)) throw error;
    const activeId = await activeOperationId(kind, operationFolderId(payload));
    const active = activeId === null ? null : await getJob(new ObjectId(activeId));
    return active === null ? startOperation(kind, payload) : { job: active, joined: true };
  }
}

export interface OperationWait {
  timeoutMs: number;
  intervalMs: number;
}

/**
 * Under the roughly 100-second cut-off of a Cloudflare tunnel, so a client
 * behind one gets the server's answer rather than the proxy's error.
 */
export const DEFAULT_OPERATION_WAIT: OperationWait = { timeoutMs: 90_000, intervalMs: 250 };

/** One request's wait: until `deadline`, or until the client goes away. */
export interface OperationDeadline {
  deadline: number;
  intervalMs: number;
  signal?: AbortSignal;
}

export const operationDeadline = (
  wait: OperationWait,
  signal?: AbortSignal,
): OperationDeadline => ({
  deadline: Date.now() + wait.timeoutMs,
  intervalMs: wait.intervalMs,
  signal,
});

const FINISHED: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);

/** The row once it has finished, or null when it is still going at the deadline or the client left. */
export async function awaitOperation(
  id: ObjectId,
  until: OperationDeadline,
): Promise<JobWithId | null> {
  const job = await getJob(id);
  if (job === null) throw new Error(`Job ${id.toHexString()} is not in the database`);
  if (FINISHED.has(job.status)) return job;
  if (Date.now() >= until.deadline || until.signal?.aborted) return null;
  await sleep(until.intervalMs, undefined, { signal: until.signal }).catch(() => undefined);
  return awaitOperation(id, until);
}

/**
 * An operation that ran at or after this request arrived: one already active
 * may have read the database before the caller's change, so its result is not
 * the caller's. Waits it out, then starts another, unless a third request
 * started one first.
 */
export async function startFreshOperation(
  kind: OperationKind,
  payload: Record<string, unknown>,
  until: OperationDeadline,
): Promise<JobWithId> {
  const started = await startOperation(kind, payload);
  if (!started.joined) return started.job;
  const earlier = await awaitOperation(started.job._id, until);
  return earlier === null ? started.job : (await startOperation(kind, payload)).job;
}
