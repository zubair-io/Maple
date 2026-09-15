import type { Db, Document } from 'mongodb';
import { isMapleId } from '../../../web/projects/maple-common/src/lib/addressing/maple-id-parser.ts';

export const ID_COLLECTIONS = [
  'assets',
  'upload_sessions',
  'meilisearch_backfill_failures',
] as const;
export type IdStatus = 'canonical' | 'noncanonical-case' | 'malformed' | 'missing-legacy';
export function idStatus(value: unknown): IdStatus {
  if (value === undefined || value === null || value === '') return 'missing-legacy';
  if (!isMapleId(value)) return 'malformed';
  return value === value.toLowerCase() ? 'canonical' : 'noncanonical-case';
}

/** Read-only, bounded-memory scan. The caller streams findings to its report. */
export async function auditMapleIds(db: Db, emit: (finding: Document) => void | Promise<void>) {
  const counts: Record<string, Record<IdStatus, number>> = {};
  for (const name of ID_COLLECTIONS) {
    const totals = { canonical: 0, 'noncanonical-case': 0, malformed: 0, 'missing-legacy': 0 };
    counts[name] = totals;
    const cursor = db.collection(name).find(
      {},
      {
        projection: { maple_id: 1, status: 1 },
        batchSize: 250,
      },
    );
    try {
      for await (const row of cursor) {
        const status = idStatus(row.maple_id);
        totals[status]++;
        if (status !== 'canonical') {
          await emit({
            type: status,
            collection: name,
            record: row._id,
            value: row.maple_id ?? null,
            status: row.status,
          });
        }
        if (name !== 'assets' && isMapleId(row.maple_id)) {
          const exact = await db
            .collection('assets')
            .findOne({ maple_id: row.maple_id }, { projection: { _id: 1 } });
          if (!exact) {
            await emit({
              type: 'unresolved-reference',
              collection: name,
              record: row._id,
              value: row.maple_id,
            });
          }
        }
      }
    } finally {
      await cursor.close();
    }
  }
  // Count only asset owners: repeated session references are expected, not collisions.
  // A binary unique index allows differently-cased spellings of the same bytes.
  const collisions = db
    .collection('assets')
    .aggregate(
      [
        { $match: { maple_id: { $type: 'string', $regex: '^[0-9a-fA-F]{32}$' } } },
        { $group: { _id: { $toLower: '$maple_id' }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ],
      { allowDiskUse: true, batchSize: 250 },
    );
  let collisionGroups = 0;
  try {
    for await (const group of collisions) {
      collisionGroups++;
      await emit({ type: 'potential-collision', canonical: group._id, count: group.count });
      const owners = db
        .collection('assets')
        .find(
          { maple_id: { $regex: `^${group._id}$`, $options: 'i' } },
          { projection: { maple_id: 1 }, batchSize: 250 },
        );
      try {
        for await (const owner of owners)
          await emit({
            type: 'collision-owner',
            canonical: group._id,
            record: owner._id,
            value: owner.maple_id,
          });
      } finally {
        await owners.close();
      }
    }
  } finally {
    await collisions.close();
  }
  return { counts, collisionGroups, identityVerified: false, consistentSnapshot: false };
}
