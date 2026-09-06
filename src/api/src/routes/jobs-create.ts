/** Shared creation responses keep first submissions and failed-only retries consistent. */
import type { ObjectId } from 'mongodb';
import type { JobWithId } from '../db/schema.ts';
import {
  createJob,
  getJob,
  JobConflictError,
  jobConflictMessage,
} from '../job-runner/jobs.repo.ts';
import { parseSyncPayload } from '../job-runner/handlers/batch-adjustment-sync.ts';

export async function createdJobResponse(
  create: () => Promise<JobWithId>,
  set: { status?: number | string },
): Promise<{ id: string } | { error: string }> {
  try {
    const job = await create();
    set.status = 201;
    return { id: job._id.toHexString() };
  } catch (error) {
    const message = jobConflictMessage(error);
    if (!message) throw error;
    set.status = 409;
    return { error: message };
  }
}

export async function createRetryFailedJob(id: ObjectId, requestId?: string): Promise<JobWithId> {
  const previous = await getJob(id);
  if (
    !previous ||
    previous.kind !== 'batch_adjustment_sync' ||
    !['done', 'cancelled', 'failed'].includes(previous.status)
  ) {
    throw new JobConflictError('Wait for the batch to stop before retrying failures');
  }
  const payload = parseSyncPayload(previous.payload);
  const entries = previous.checkpoint?.['failed'];
  const failed = new Set(Array.isArray(entries) ? entries.map((entry) => entry.id) : []);
  const ledger = previous.checkpoint?.['entries'];
  const prepared = new Map(
    Array.isArray(ledger) ? ledger.filter(Boolean).map((entry) => [entry.id, entry.patch]) : [],
  );
  const targets = payload.targets
    .filter((target) => failed.has(target.id))
    .map((target) => {
      const patch = prepared.get(target.id);
      return { ...target, ...(patch ? { patch } : {}) };
    });
  if (targets.length === 0) {
    throw new JobConflictError('This batch has no failures to retry');
  }
  return createJob({
    kind: 'batch_adjustment_sync',
    payload: {
      targets,
      patch: payload.patch,
      ...(payload.relativeWhiteBalance
        ? { relativeWhiteBalance: payload.relativeWhiteBalance }
        : {}),
    },
    requestId,
  });
}
