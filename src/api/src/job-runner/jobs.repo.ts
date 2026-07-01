/**
 * Mongo accessor for the `jobs` collection. Mirrors the geocode worker's
 * claim-and-lease shape (`docs/indexer-enrichment.md` §3.1) but at job-doc
 * granularity rather than per-stage state.
 *
 * The repo is a thin wrapper — no business logic. It exists so the runner,
 * the HTTP routes, and the tests share a single set of typed Mongo
 * operations and can't drift on field names.
 */

import type { ObjectId } from 'mongodb';
import { type WithId } from 'mongodb';
import { jobsCollection } from '../db/client.ts';
import type { JobDoc, JobKind, JobStatus, JobWithId } from '../db/schema.ts';

export interface CreateJobInput {
  kind: JobKind;
  payload: Record<string, unknown>;
}

/** Snapshot returned by `claim()` — enough for the runner to hand to a
 * handler without forcing the runner to re-query the doc. */
export interface ClaimedJob {
  _id: ObjectId;
  kind: JobKind;
  payload: Record<string, unknown>;
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
  const q: Record<string, unknown> = {};
  if (filter.statuses && filter.statuses.length > 0) {
    q.status = { $in: filter.statuses };
  } else if (filter.status) {
    q.status = filter.status;
  }
  if (filter.kind) q.kind = filter.kind;
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
  };
}

/** Patch progress counters on an in-flight claim. Renews the lease so a
 * long handler that's making progress doesn't get reaped. */
export async function updateProgress(
  id: ObjectId,
  progress: { current: number; total: number },
  leaseMs: number,
  now: () => Date = () => new Date(),
): Promise<void> {
  const c = await jobsCollection();
  const nowDate = now();
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  await c.updateOne(
    { _id: id },
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
): Promise<void> {
  const c = await jobsCollection();
  const nowIso = now().toISOString();
  await c.updateOne(
    { _id: id },
    {
      $set: {
        status: 'done' as JobStatus,
        result,
        error: null,
        locked_by: null,
        lease_expires_at: null,
        updated_at: nowIso,
      },
    },
  );
}

/** Mark a job failed with an error message. Releases the lock. */
export async function failJob(
  id: ObjectId,
  error: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const c = await jobsCollection();
  const nowIso = now().toISOString();
  await c.updateOne(
    { _id: id },
    {
      $set: {
        status: 'failed' as JobStatus,
        error,
        locked_by: null,
        lease_expires_at: null,
        updated_at: nowIso,
      },
    },
  );
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
): Promise<void> {
  const c = await jobsCollection();
  const nowIso = now().toISOString();
  await c.updateOne(
    { _id: id },
    {
      $set: {
        status: 'cancelled' as JobStatus,
        result,
        locked_by: null,
        lease_expires_at: null,
        updated_at: nowIso,
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
