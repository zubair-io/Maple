/**
 * Face-count maintenance helpers — denormalised `face_count` on `PersonDoc`.
 *
 * The `/api/people` list used to call `faceCountByPerson()` (an O(total-faces)
 * $unwind aggregation) on EVERY request, causing 5 s+ latency at scale. The fix
 * is to denormalise the count onto each person doc and maintain it incrementally
 * on every write that changes face membership. The clustering pass (which already
 * walks the whole face space) writes an authoritative recompute once per run,
 * self-healing any incremental drift.
 *
 * Public surface:
 *   faceCountByPerson()             — repair/migration primitive (not per-request)
 *   adjustPersonFaceCount(hex, ±N)  — atomic ±1 / ±N on a single person
 *   writeAuthoritativeFaceCounts    — called by the clustering pass
 *   backfillPersonFaceCount(db)     — boot-time migration (re-exported by migrations.ts)
 *
 * No `any`. snake_case Mongo fields. Functional immutable style.
 */

import { ObjectId, type AnyBulkWriteOperation, type Db, type Filter } from 'mongodb';
import { assetsCollection, peopleCollection } from '../db/client.ts';
import type { PersonDoc } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('people:face-count');

// ---------------------------------------------------------------------------
// Repair / migration primitive
// ---------------------------------------------------------------------------

/**
 * Aggregate `asset.faces` grouped by `person_id` and return a map from hex
 * person id to count. Excludes faces with no `person_id` and hidden faces.
 *
 * Used by the backfill migration and exposed for ad-hoc repair. NOT called on
 * the hot GET /api/people path — that reads `person.face_count` directly.
 */
export async function faceCountByPerson(): Promise<Map<string, number>> {
  const assets = await assetsCollection();
  const cursor = assets.aggregate<{ _id: string; count: number }>([
    { $match: { faces: { $exists: true, $ne: [] } } },
    { $unwind: '$faces' },
    {
      $match: {
        'faces.person_id': { $ne: null },
        'faces.hidden': { $ne: true },
      },
    },
    { $group: { _id: '$faces.person_id', count: { $sum: 1 } } },
  ]);
  const out = new Map<string, number>();
  for await (const row of cursor) {
    if (typeof row._id === 'string') out.set(row._id, row.count);
  }
  return out;
}

/**
 * Recompute ONE person's `face_count` from their actual assigned, non-hidden
 * faces and write it. Used where trusting the stored count is unsafe — e.g.
 * after a merge repoints an orphan's faces onto the survivor, the survivor's
 * count is recomputed from ground truth rather than summing a possibly-drifted
 * stored value. Returns the recomputed count.
 */
export async function recomputePersonFaceCount(personHex: string): Promise<number> {
  let oid: ObjectId;
  try {
    oid = new ObjectId(personHex);
  } catch {
    log.warn({ personHex }, 'recomputePersonFaceCount: invalid hex id — skipping');
    return 0;
  }
  const assets = await assetsCollection();
  const cursor = assets.aggregate<{ count: number }>([
    { $match: { 'faces.person_id': personHex } },
    { $unwind: '$faces' },
    { $match: { 'faces.person_id': personHex, 'faces.hidden': { $ne: true } } },
    { $count: 'count' },
  ]);
  let count = 0;
  for await (const row of cursor) count = row.count;
  const coll = await peopleCollection();
  await coll.updateOne({ _id: oid }, { $set: { face_count: count } });
  return count;
}

// ---------------------------------------------------------------------------
// Incremental maintenance
// ---------------------------------------------------------------------------

/**
 * Atomically adjust `face_count` by `delta` (typically +1 or -1) for the
 * person identified by `personHex`. A no-op when `personHex` is null/empty or
 * `delta` is zero.
 *
 * Uses an aggregation-pipeline update (not `$inc`) so a missing/unset
 * `face_count` is treated as 0 and the result is clamped at 0 — a legacy
 * person with no field, or a stray double-decrement, can never drive the
 * count negative. The person is looked up by ObjectId so the `_id` index is
 * used and the update is O(1).
 */
export async function adjustPersonFaceCount(
  personHex: string | null,
  delta: number,
): Promise<void> {
  if (!personHex || delta === 0) return;
  let oid: ObjectId;
  try {
    oid = new ObjectId(personHex);
  } catch {
    log.warn({ personHex }, 'adjustPersonFaceCount: invalid hex id — skipping');
    return;
  }
  const coll = await peopleCollection();
  await coll.updateOne({ _id: oid }, [
    {
      $set: {
        face_count: {
          $max: [0, { $add: [{ $ifNull: ['$face_count', 0] }, delta] }],
        },
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Authoritative recompute (called by the clustering pass)
// ---------------------------------------------------------------------------

/**
 * Write authoritative `face_count` values from the clustering pass's already-
 * computed per-person tallies via a single `bulkWrite`. The pass already walks
 * every assigned face, so it can produce exact counts at zero extra cost; this
 * makes each clustering run the self-healing source of truth for any incremental
 * drift that accumulated between passes.
 *
 * Truly authoritative: it writes EVERY live (non-merged) person, setting
 * `face_count = counts.get(id) ?? 0`. A person who is absent from `counts`
 * (their faces all dropped to zero since the last pass) is reset to 0 — so
 * drift heals DOWN as well as up. `counts` is a Map from person hex id → count.
 */
export async function writeAuthoritativeFaceCounts(counts: Map<string, number>): Promise<void> {
  const coll = await peopleCollection();
  // Drive the write off the live-people set, not the counts map, so people
  // who dropped to zero get corrected (they won't appear in `counts`).
  const people = await coll
    .find({ merged_into: null } as Filter<PersonDoc>)
    .project<{ _id: ObjectId }>({ _id: 1 })
    .toArray();
  if (people.length === 0) return;
  const ops: AnyBulkWriteOperation<PersonDoc>[] = people.map((p) => ({
    updateOne: {
      filter: { _id: p._id },
      update: { $set: { face_count: counts.get(p._id.toHexString()) ?? 0 } },
    },
  }));
  const res = await coll.bulkWrite(ops, { ordered: false });
  log.debug(
    { updated: res.modifiedCount, total: ops.length },
    'wrote authoritative face counts from clustering pass',
  );
}

// ---------------------------------------------------------------------------
// Boot-time migration helper (re-exported by migrations.ts)
// ---------------------------------------------------------------------------

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
    { $match: { faces: { $exists: true, $ne: [] } } },
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
