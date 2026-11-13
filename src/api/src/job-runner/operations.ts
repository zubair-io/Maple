/**
 * How a route starts an operator one-shot and, for the routes that answer with
 * its outcome, waits for it. The route only writes the row; the operations lane
 * in the worker tier runs it (`operation-queue.ts`).
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { ObjectId } from '../db/object-id.ts';
import {
  activeOperationId,
  operationStatus,
  waitingOperationId,
} from '../db/repos/operations.repo.ts';
import type { JobWithId, OperationKind } from '../db/schema.ts';
import { createJob, getJob, JobConflictError, operationFolderId } from './jobs.repo.ts';

export interface StartedOperation {
  job: JobWithId;
  /** True when one was already active and the request joined it instead. */
  joined: boolean;
}

/**
 * Creates the reconcile or scan, or answers with the one already active in its
 * place: the insert refuses a second active one (per folder, for a scan). One
 * that finishes between the refusal and the lookup leaves room for this one,
 * so the insert is tried again. Clustering never joins a running pass; see
 * {@link startClustering}.
 */
export async function startOperation(
  kind: Exclude<OperationKind, 'people_cluster'>,
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
  const status = await operationStatus(id);
  if (status === null) throw new Error(`Job ${id.toHexString()} is not in the database`);
  const finished = FINISHED.has(status) ? await getJob(id) : null;
  if (finished !== null) return finished;
  if (Date.now() >= until.deadline || until.signal?.aborted) return null;
  await sleep(until.intervalMs, undefined, { signal: until.signal }).catch(() => undefined);
  return awaitOperation(id, until);
}

/**
 * A clustering pass that starts after this request arrived: one already running
 * may have read the database before the caller's change, so its result is not
 * the caller's. The request gets a row of its own, which the lane hands over
 * once the running one has finished, so the pass happens whether or not the
 * caller is still waiting. A request with the same payload that has not
 * started yet is joined instead; one that starts between the refusal and the
 * lookup leaves room for this one, so the insert is tried again.
 */
export async function startClustering(payload: Record<string, unknown>): Promise<JobWithId> {
  try {
    return await createJob({ kind: 'people_cluster', payload });
  } catch (error) {
    if (!(error instanceof JobConflictError)) throw error;
    const waitingId = await waitingOperationId(payload);
    const waiting = waitingId === null ? null : await getJob(new ObjectId(waitingId));
    return waiting ?? startClustering(payload);
  }
}
