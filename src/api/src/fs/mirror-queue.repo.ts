/**
 * mirror_queue repo — the durable work queue between the *detectors* (the
 * mirror-scan worker + the inline `onMirrorFailure` sink) and the mirror *copy*
 * worker. Detectors only enqueue; the copy worker claims, copies, and
 * completes/retries. Claim is atomic (`findOneAndUpdate`) with a lease so a
 * crashed worker's row is retaken. Mirrors the `discover_frontier` pattern.
 */

import type { ObjectId, WithId } from 'mongodb';
import { mirrorQueueCollection } from '../db/client.ts';
import type { MirrorQueueDoc } from '../db/schema.ts';

export type MirrorQueueEntry = WithId<MirrorQueueDoc>;

/**
 * Enqueue (or refresh) a pending copy. Idempotent on `mirror_path`: a row that
 * already exists keeps its `enqueued_at`/`attempts`/`dead` state — only the
 * source path + reason are refreshed — so re-detection and repeated failures
 * coalesce onto one row instead of flooding the queue. Never throws on a
 * concurrent-insert duplicate.
 */
export async function enqueueMirrorCopy(
  primaryPath: string,
  mirrorPath: string,
  reason: MirrorQueueDoc['reason'],
): Promise<void> {
  const coll = await mirrorQueueCollection();
  try {
    await coll.updateOne(
      { mirror_path: mirrorPath },
      {
        $set: { primary_path: primaryPath, reason },
        $setOnInsert: {
          enqueued_at: Date.now(),
          attempts: 0,
          last_error: null,
          dead: false,
          claimed_at: null,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    // Two writers racing the same mirror_path can both miss the unique row and
    // attempt an insert; one wins, the other gets E11000. That's a no-op for
    // us (the row exists) — swallow only that case.
    if ((err as { code?: number } | null)?.code !== 11000) throw err;
  }
}

/** Atomically claim the oldest free (or lease-expired), non-dead row. */
export async function claimNextMirrorCopy(leaseMs: number): Promise<MirrorQueueEntry | null> {
  const coll = await mirrorQueueCollection();
  const now = Date.now();
  const res = await coll.findOneAndUpdate(
    { dead: { $ne: true }, $or: [{ claimed_at: null }, { claimed_at: { $lt: now } }] },
    { $set: { claimed_at: now + leaseMs } },
    { sort: { enqueued_at: 1, _id: 1 }, returnDocument: 'after' },
  );
  return res as MirrorQueueEntry | null;
}

/** Remove a finished row. */
export async function completeMirrorCopy(id: ObjectId): Promise<void> {
  const coll = await mirrorQueueCollection();
  await coll.deleteOne({ _id: id });
}

/**
 * Record a failed copy: bump `attempts`, store the error, release the claim,
 * and dead-letter once `attempts` reaches `maxAttempts`. A single
 * aggregation-pipeline update so the dead flag is derived from the *new*
 * attempt count atomically.
 */
export async function failMirrorCopy(
  id: ObjectId,
  errorMessage: string,
  maxAttempts: number,
): Promise<void> {
  const coll = await mirrorQueueCollection();
  await coll.updateOne({ _id: id }, [
    {
      $set: {
        attempts: { $add: [{ $ifNull: ['$attempts', 0] }, 1] },
        last_error: errorMessage,
        claimed_at: null,
      },
    },
    { $set: { dead: { $gte: ['$attempts', maxAttempts] } } },
  ]);
}

/** Queue depth counts for status/diagnostics. */
export async function mirrorQueueCounts(): Promise<{ pending: number; dead: number }> {
  const coll = await mirrorQueueCollection();
  const [pending, dead] = await Promise.all([
    coll.countDocuments({ dead: { $ne: true } }),
    coll.countDocuments({ dead: true }),
  ]);
  return { pending, dead };
}

/** Clear the dead flag + attempts on every dead-lettered row (operator "retry"). */
export async function retryDeadMirrorCopies(): Promise<number> {
  const coll = await mirrorQueueCollection();
  const res = await coll.updateMany(
    { dead: true },
    { $set: { dead: false, attempts: 0, last_error: null, claimed_at: null } },
  );
  return res.modifiedCount;
}
