/**
 * Mongo accessor for the `jobs` collection. Mirrors the geocode worker's
 * claim-and-lease shape (`docs/indexer-enrichment.md` §3.1) but at job-doc
 * granularity rather than per-stage state.
 *
 * The repo is a thin wrapper — no business logic. It exists so the runner,
 * the HTTP routes, and the tests share a single set of typed Mongo
 * operations and can't drift on field names.
 */

import { ObjectId } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import { type WithId } from 'mongodb';
import { jobsCollection } from '../db/client.ts';
import type { JobDoc, JobKind, JobStatus, JobWithId } from '../db/schema.ts';

export class JobRequestConflictError extends Error {
  constructor() {
    super('The request id already belongs to a different job');
  }
}

export interface CreateJobInput {
  kind: JobKind;
  payload: Record<string, unknown>;
  /** Optional caller-generated identity makes a lost creation response recoverable. */
  requestId?: string;
}

/** Snapshot returned by `claim()` — enough for the runner to hand to a
 * handler without forcing the runner to re-query the doc. */
export interface ClaimedJob {
  _id: ObjectId;
  kind: JobKind;
  payload: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
}

export interface ListJobsFilter {
  /** Match a single status (exact). Use `statuses` to match multiple. */
  status?: JobStatus;
  /** Match any of the given statuses (IN query). Takes precedence over `status`
   * when both are provided. Used by the pano concurrency guard to block both
   * 'queued' and 'running' jobs with a single query. */
  statuses?: JobStatus[];
  kind?: JobKind;
  limit?: number;
}

/** Insert a queued job. Returns the new document with all defaults. */
export async function createJob(
  input: CreateJobInput,
  now: () => Date = () => new Date(),
): Promise<JobWithId> {
  const c = await jobsCollection();
  const nowIso = now().toISOString();
  const doc: JobDoc = {
    kind: input.kind,
    status: 'queued',
    payload: input.payload,
    progress: { current: 0, total: 0 },
    result: null,
    error: null,
    locked_by: null,
    lease_expires_at: null,
    cancel_requested: false,
    created_at: nowIso,
    updated_at: nowIso,
  };
  if (input.requestId) {
    const id = new ObjectId(input.requestId);
    const existing = await c.findOneAndUpdate(
      { _id: id },
      { $setOnInsert: doc },
      { upsert: true, returnDocument: 'after' },
    );
    if (
      !existing ||
      existing.kind !== input.kind ||
      !isDeepStrictEqual(existing.payload, input.payload)
    ) {
      throw new JobRequestConflictError();
    }
    return existing as JobWithId;
  }
  const result = await c.insertOne(doc as JobDoc);
  return { _id: result.insertedId, ...doc } as JobWithId;
}

/** Fetch a single job by id. Returns null if no match. */
export async function getJob(id: ObjectId): Promise<JobWithId | null> {
  const c = await jobsCollection();
  return (await c.findOne({ _id: id })) as JobWithId | null;
}

/** List jobs filtered by status and/or kind, newest first. Hard-capped at 200. */
export async function listJobs(filter: ListJobsFilter): Promise<JobWithId[]> {
  const c = await jobsCollection();
  const status = filter.statuses?.length ? { $in: filter.statuses } : filter.status;
  const q = { ...(status ? { status } : {}), ...(filter.kind ? { kind: filter.kind } : {}) };
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
  const docs = (await c
    .find(q)
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray()) as WithId<JobDoc>[];
  return docs as JobWithId[];
}

/**
 * Atomic claim. Filter:
 *
 *   - status === "queued" with no lock, OR
 *   - status === "running" with an expired lease (the previous worker
 *     died mid-job; another worker is allowed to take over).
 *
 * Bumps `locked_by` + `lease_expires_at` + status: "running" in one
 * operation. Mongo guarantees only one worker wins.
 */
export async function claimJob(
  workerId: string,
  leaseMs: number,
  now: () => Date = () => new Date(),
): Promise<ClaimedJob | null> {
  const c = await jobsCollection();
  const nowDate = now();
  const nowIso = nowDate.toISOString();
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  const filter = {
    $or: [
      { status: 'queued' as JobStatus, locked_by: null },
      {
        status: 'running' as JobStatus,
        lease_expires_at: { $lt: nowIso },
      },
    ],
  };
  const update = {
    $set: {
      status: 'running' as JobStatus,
      locked_by: workerId,
      lease_expires_at: leaseExpiresAt,
      updated_at: nowIso,
    },
  };
  const result = await c.findOneAndUpdate(filter, update, {
    sort: { created_at: 1, _id: 1 },
    returnDocument: 'after',
  });
  if (!result) return null;
  return {
    _id: result._id,
    kind: result.kind,
    payload: result.payload,
    checkpoint: result.checkpoint,
  };
}

/** Patch progress counters on an in-flight claim. Renews the lease so a
 * long handler that's making progress doesn't get reaped. */
export async function updateProgress(
  id: ObjectId,
  progress: { current: number; total: number },
  leaseMs: number,
  now: () => Date = () => new Date(),
  workerId?: string,
): Promise<void> {
  const c = await jobsCollection();
  const nowDate = now();
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  await c.updateOne(
    { _id: id, ...(workerId ? { locked_by: workerId, status: 'running' as JobStatus } : {}) },
    {
      $set: {
        progress,
        lease_expires_at: leaseExpiresAt,
        updated_at: nowDate.toISOString(),
      },
    },
  );
}

/** Mark a job done with its result payload. Releases the lock. */
export async function completeJob(
  id: ObjectId,
  result: Record<string, unknown>,
  now: () => Date = () => new Date(),
  workerId?: string,
): Promise<void> {
  await setTerminalState(id, { status: 'done', result, error: null }, now(), workerId);
}

/** Mark a job failed with an error message. Releases the lock. */
export async function failJob(
  id: ObjectId,
  error: string,
  now: () => Date = () => new Date(),
  workerId?: string,
): Promise<void> {
  await setTerminalState(id, { status: 'failed', error }, now(), workerId);
}

/**
 * Mark a job cancelled — handler observed `cancel_requested` and exited.
 * `result` may carry a partial payload (e.g. how many assets did succeed
 * before the cancel) so the API caller can surface the partial work.
 */
export async function markCancelled(
  id: ObjectId,
  result: Record<string, unknown> | null = null,
  now: () => Date = () => new Date(),
  workerId?: string,
): Promise<void> {
  await setTerminalState(id, { status: 'cancelled', result }, now(), workerId);
}

/** Keep lease fencing identical for every terminal transition. */
async function setTerminalState(
  id: ObjectId,
  fields: Partial<JobDoc>,
  at: Date,
  workerId?: string,
): Promise<void> {
  const jobs = await jobsCollection();
  const owner = workerId ? { locked_by: workerId, status: 'running' as JobStatus } : {};
  await jobs.updateOne(
    { _id: id, ...owner },
    {
      $set: {
        ...fields,
        locked_by: null,
        lease_expires_at: null,
        updated_at: at.toISOString(),
      },
    },
  );
}

/** Flip the `cancel_requested` flag. The runner observes it between
 * progress steps and exits cleanly. Returns true if the job exists. */
export async function requestCancel(
  id: ObjectId,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const c = await jobsCollection();
  const r = await c.updateOne(
    { _id: id },
    {
      $set: {
        cancel_requested: true,
        updated_at: now().toISOString(),
      },
    },
  );
  return r.matchedCount > 0;
}

/** Read just the cancel flag. Used by handlers between progress steps. */
export async function isCancelRequested(id: ObjectId): Promise<boolean> {
  const c = await jobsCollection();
  const doc = await c.findOne({ _id: id }, { projection: { cancel_requested: 1 } });
  return doc?.cancel_requested === true;
}

/** Fence checkpoint writes to the lease owner so a reclaimed job cannot be
 * overwritten by the former worker. Renew before each sidecar commit. */
export async function saveJobCheckpoint(
  id: ObjectId,
  workerId: string,
  checkpoint: Record<string, unknown>,
  leaseMs: number,
  now: () => Date = () => new Date(),
): Promise<void> {
  const c = await jobsCollection();
  const at = now();
  const result = await c.updateOne(
    { _id: id, locked_by: workerId, status: 'running' },
    {
      $set: {
        checkpoint,
        updated_at: at.toISOString(),
        lease_expires_at: new Date(at.getTime() + leaseMs).toISOString(),
      },
    },
  );
  if (result.matchedCount !== 1) throw new Error('The job lease was claimed by another worker');
}

/** Resume only unfinished entries of an interrupted batch; the saved ledger is retained. */
export async function resumeBatchJob(id: ObjectId): Promise<boolean> {
  const c = await jobsCollection();
  const result = await c.updateOne(
    { _id: id, kind: 'batch_adjustment_sync', status: { $in: ['failed', 'cancelled'] } },
    {
      $set: {
        status: 'queued',
        locked_by: null,
        lease_expires_at: null,
        cancel_requested: false,
        error: null,
        result: null,
        updated_at: new Date().toISOString(),
      },
    },
  );
  return result.matchedCount === 1;
}
