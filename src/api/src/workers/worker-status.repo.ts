/**
 * `worker_status` single-document collection.
 *
 * The worker process writes a snapshot of `stageRegistry.statuses()` here every
 * ~2 s (via an unref'd interval in `start-workers.ts`).  The API process reads
 * it in `computeWorkersStatus()` instead of the now-empty in-process registry
 * so `GET /api/workers/status` shows live stage state across the process
 * boundary.
 *
 * Single-doc design: fixed `_id: 'singleton'` — upsert on every write, read the
 * one document back.  No time-series, no history.
 */
import { getDb } from '../db/client.ts';
import type { StageStatusSnapshot } from './registry.ts';

export interface WorkerStatusDoc {
  _id: string;
  statuses: Record<string, StageStatusSnapshot>;
  updated_at: number;
}

/**
 * Write the current stage-registry snapshot to the `worker_status` collection.
 * Upserts the singleton document so the first write creates it.
 *
 * NOTE: do NOT include `_id` in `$set` — Mongo rejects mutations of the
 * immutable `_id` field on update.
 */
export async function writeWorkerStatus(
  snapshot: Record<string, unknown>,
  updatedAt: number,
): Promise<void> {
  const coll = (await getDb()).collection<WorkerStatusDoc>('worker_status');
  await coll.updateOne(
    { _id: 'singleton' },
    { $set: { statuses: snapshot as Record<string, StageStatusSnapshot>, updated_at: updatedAt } },
    { upsert: true },
  );
}

/**
 * Read the most recent worker-status snapshot written by the worker process.
 * Returns `null` when the collection is empty (worker hasn't written yet) OR
 * when Mongo is unreachable — so callers never see a rejected promise and
 * `GET /api/workers/status` degrades gracefully when the DB is down.
 */
export async function readWorkerStatus(): Promise<{
  statuses: Record<string, StageStatusSnapshot>;
  updated_at: number;
} | null> {
  try {
    const coll = (await getDb()).collection<WorkerStatusDoc>('worker_status');
    const doc = await coll.findOne({ _id: 'singleton' });
    if (!doc) return null;
    return { statuses: doc.statuses, updated_at: doc.updated_at };
  } catch {
    return null;
  }
}
