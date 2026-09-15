/** Database-bootstrap migration: only uses the supplied Db, never the client singleton. */
import type { Db, ObjectId } from 'mongodb';
import { child as childLogger } from '../log.ts';

const log = childLogger('people:face-count');

export interface BackfillPersonFaceCountResult {
  updated: number;
  zeroed: number;
}

/**
 * Populate `face_count` on every live (non-merged) `PersonDoc`. Uses the
 * same aggregation semantics as `faceCountByPerson()` so counts match.
 * Idempotent — re-running overwrites with the same value. Called once at
 * boot via the `backfill-person-face-count-2026-06-27` migration sentinel.
 *
 * Takes `Db` directly (mirrors every other migration helper) so the
 * `migrations.ts` module can call it without creating a circular import
 * through `db/client.ts`.
 */
export async function backfillPersonFaceCount(db: Db): Promise<BackfillPersonFaceCountResult> {
  const cursor = db.collection('assets').aggregate<{ _id: string; count: number }>([
    {
      $match: {
        deleted_at: null,
        fileinfo: { $elemMatch: { deleted_at: null, missing_since: null } },
        faces: { $exists: true, $ne: [] },
      },
    },
    { $unwind: '$faces' },
    {
      $match: {
        'faces.person_id': { $ne: null },
        'faces.hidden': { $ne: true },
      },
    },
    { $group: { _id: '$faces.person_id', count: { $sum: 1 } } },
  ]);
  const counts = new Map<string, number>();
  for await (const row of cursor) {
    if (typeof row._id === 'string') counts.set(row._id, row.count);
  }

  const people = await db
    .collection('people')
    .find({ merged_into: null })
    .project<{ _id: ObjectId }>({ _id: 1 })
    .toArray();

  let updated = 0;
  let zeroed = 0;
  const BATCH = 500;
  for (let i = 0; i < people.length; i += BATCH) {
    const ops = people.slice(i, i + BATCH).map((p) => {
      const count = counts.get(p._id.toHexString()) ?? 0;
      if (count === 0) zeroed += 1;
      else updated += 1;
      return { updateOne: { filter: { _id: p._id }, update: { $set: { face_count: count } } } };
    });
    if (ops.length > 0) await db.collection('people').bulkWrite(ops, { ordered: false });
  }
  log.info({ updated, zeroed }, 'backfilled person face counts');
  return { updated, zeroed };
}
