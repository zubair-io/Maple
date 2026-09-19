/**
 * A throwaway MongoDB library for the importer tests.
 *
 * Deliberately small and deliberately awkward. Row counts alone would be
 * satisfied by a library of identical well-formed documents, and that is
 * exactly the library that proves nothing: every bug worth catching here lives
 * in a shape the schema has to accommodate rather than in the happy path. The
 * asset documents are in `seed-assets.test-helpers.ts` and everything else is
 * in `seed-ops.test-helpers.ts`; this module is the connection, the folders and
 * people the rest of the graph points at, and the orchestration.
 *
 * It connects to :27077 — a throwaway mongod on a dev machine — and never to
 * :27017, which is a developer's real library.
 */

import { MongoClient, type Db } from 'mongodb';
import { seedAssets } from './seed-assets.test-helpers.ts';
import { iso, newSeedIds, TEST_MONGO_URI, type SeedIds } from './seed-fixtures.test-helpers.ts';
import {
  seedAuth,
  seedChanges,
  seedNotImported,
  seedOperational,
} from './seed-ops.test-helpers.ts';

export { TEST_MONGO_URI, type SeedIds } from './seed-fixtures.test-helpers.ts';

/**
 * Connects to the throwaway instance, or returns null when it is not running.
 *
 * Null is the signal every Mongo-backed suite in this repository uses to
 * skip-pass rather than fail on a machine without a database, and the timeouts
 * are short so that verdict arrives in a second and a half rather than at bun's
 * test timeout.
 */
export async function connectTestMongo(): Promise<MongoClient | null> {
  const client = new MongoClient(TEST_MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return client;
  } catch {
    await client.close().catch(() => {});
    return null;
  }
}

/** Writes the whole library. Returns the ids the tests assert on. */
export async function seedLibrary(db: Db, options: { changeRows?: number } = {}): Promise<SeedIds> {
  const ids = newSeedIds();

  await db.collection('folders').insertMany([
    {
      _id: ids.libraryA,
      path: '/libraries/a',
      slug: 'library-a',
      label: 'Library A',
      last_scan: iso(1),
      file_count: 5,
      created_at: iso(0),
      mirrors: [{ path: '/mirrors/a', enabled: true }],
    },
    {
      _id: ids.libraryB,
      path: '/libraries/b',
      slug: 'library-b',
      label: 'Library B',
      last_scan: null,
      file_count: 1,
      created_at: iso(0),
    },
  ] as never);

  await db.collection('people').insertMany([
    {
      _id: ids.person,
      name: 'Alice Example',
      created_at: iso(0),
      updated_at: iso(3),
      cover_asset_id: ids.assets.rich.toHexString(),
      cover_bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      centroid: [0.1, 0.2, 0.3],
      centroid_face_count: 2,
      face_count: 2,
      hidden: false,
      excluded: false,
      suggested_merge_person_id: ids.mergedPerson,
      suggested_merge_score: 0.91,
      suggested_merges: [{ person_id: ids.mergedPerson, score: 0.91 }],
    },
    {
      _id: ids.mergedPerson,
      name: 'Alice E.',
      created_at: iso(0),
      updated_at: iso(4),
      merged_into: ids.person,
    },
  ] as never);

  await db.collection('person_merge_dismissals').insertOne({
    pair: `${ids.person.toHexString()}:${ids.mergedPerson.toHexString()}`,
    created_at: iso(5),
  } as never);

  await seedAssets(db, ids);
  await seedOperational(db, ids);
  await seedAuth(db, ids);
  ids.changeCursors = await seedChanges(db, ids, options.changeRows ?? 12);
  await seedNotImported(db, ids);
  return ids;
}
