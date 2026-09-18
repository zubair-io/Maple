/**
 * Clustering parity: the SQLite pass and the MongoDB pass must produce the same
 * assignments from the same input (#3749).
 *
 * This is the ticket's first exit criterion, and it is checked the only way that
 * actually settles it — by running both implementations over the same fixture
 * and comparing. A test that exercised the SQLite pass alone could only show
 * that it is self-consistent, which is not the claim being made.
 *
 * ## Why the fixtures use explicit ascending ids
 *
 * Online clustering is order-sensitive twice over. A face competes against every
 * cluster the faces before it opened, so the order faces arrive in decides the
 * answer; and a cluster id is a position in the seed list, so the order
 * centroids load in decides which person an id refers to.
 *
 * Mongo returns both in collection order, which is `_id` order for a collection
 * nothing has deleted from. SQLite returns them in the order the queries ask
 * for, which the ported statements spell as `ORDER BY id` and `ORDER BY
 * asset_id, face_index`. Those agree, and minting ids in ascending order is
 * what makes the test prove it rather than depend on two scans coincidentally
 * matching.
 *
 * Skip-passes when MongoDB is unreachable, mirroring the rest of the suite: a
 * parity test with only one side available proves nothing, and failing CI for
 * an absent service is noise.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { withTestDb } from '../../test-db.test-helpers.ts';
import { createTestDatabase, type TestDatabase } from '../test-sqlite.test-helpers.ts';
import { prepareClusteringPass as prepareSqlite } from './people.cluster-load.ts';
import {
  insertFace,
  insertLibrary,
  insertLiveAsset,
  insertPerson,
  nearAxis,
  pseudoRandom,
  testDb,
} from './people.test-helpers.ts';
import type { AssetDoc, AssetFaceDoc, PersonDoc } from '../../schema.ts';
import type { PreparedClusteringPass } from '../../../people/cluster-load.ts';

const TEST_DB = withTestDb(`maple_test_people_parity_${process.pid}`);
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoDb: Db | null = null;
let reachable = false;

/** One face of the shared fixture, in a form both engines can be given. */
interface FaceSpec {
  assetIndex: number;
  faceIndex: number;
  embedding: number[];
  hidden?: boolean;
  personIndex?: number;
}

/** One person of the shared fixture. */
interface PersonSpec {
  name: string;
  centroid?: number[];
  centroidFaceCount?: number;
  hidden?: boolean;
  excluded?: boolean;
}

interface Fixture {
  assets: number;
  people: PersonSpec[];
  faces: FaceSpec[];
}

async function tryConnect(): Promise<MongoClient | null> {
  const client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return client;
  } catch {
    await client.close().catch(() => undefined);
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  reachable = mongo !== null;
  if (!reachable) {
    console.log('[people.cluster-load.parity] skipping: MongoDB unreachable');
    return;
  }
  mongoDb = mongo!.db(TEST_DB);
  await mongoDb.dropDatabase();
  const { closeDb } = await import('../../client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!reachable) return;
  await mongoDb!.collection('people').deleteMany({});
  await mongoDb!.collection('assets').deleteMany({});
  await mongoDb!.collection('person_merge_dismissals').deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../../client.ts');
  await closeDb();
});

/** Ascending ids, so insertion order and id order coincide. See the header. */
function ascending(count: number): ObjectId[] {
  return Array.from({ length: count }, () => new ObjectId()).sort((a, b) =>
    a.toHexString().localeCompare(b.toHexString()),
  );
}

/** Write the fixture into MongoDB and run the Mongo pass. */
async function runMongo(
  fixture: Fixture,
  assetIds: ObjectId[],
  personIds: ObjectId[],
  threshold: number,
): Promise<PreparedClusteringPass> {
  const facesByAsset = new Map<number, AssetFaceDoc[]>();
  for (const face of fixture.faces) {
    const list = facesByAsset.get(face.assetIndex) ?? [];
    list[face.faceIndex] = {
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      person_id: face.personIndex === undefined ? null : personIds[face.personIndex]!.toHexString(),
      confidence: 0.9,
      embedding: face.embedding,
      ...(face.hidden ? { hidden: true } : {}),
    };
    facesByAsset.set(face.assetIndex, list);
  }

  const libraryId = new ObjectId();
  const assetDocs = assetIds.map((id, index) => ({
    _id: id,
    fileinfo: [{ path: '', filename: `${index}.jpg`, library_id: libraryId, deleted_at: null }],
    size: 1024,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    faces: facesByAsset.get(index) ?? [],
  }));
  await mongoDb!.collection('assets').insertMany(assetDocs as unknown as AssetDoc[]);

  const now = new Date().toISOString();
  const personDocs = fixture.people.map((person, index) => ({
    _id: personIds[index]!,
    name: person.name,
    created_at: now,
    updated_at: now,
    merged_into: null,
    ...(person.centroid ? { centroid: person.centroid } : {}),
    ...(person.centroidFaceCount === undefined
      ? {}
      : { centroid_face_count: person.centroidFaceCount }),
    ...(person.hidden ? { hidden: true } : {}),
    ...(person.excluded ? { excluded: true } : {}),
  }));
  if (personDocs.length > 0) {
    await mongoDb!.collection('people').insertMany(personDocs as unknown as PersonDoc[]);
  }

  const { prepareClusteringPass } = await import('../../../people/cluster-load.ts');
  return prepareClusteringPass(threshold);
}

/** Write the same fixture into SQLite and run the ported pass. */
async function runSqlite(
  handle: TestDatabase,
  fixture: Fixture,
  assetIds: ObjectId[],
  personIds: ObjectId[],
  threshold: number,
): Promise<PreparedClusteringPass> {
  const db = handle.db;
  const libraryId = insertLibrary(db);
  for (const [index, person] of fixture.people.entries()) {
    insertPerson(db, {
      id: personIds[index]!.toHexString(),
      name: person.name,
      centroid: person.centroid ?? null,
      centroidFaceCount: person.centroidFaceCount ?? null,
      hidden: person.hidden,
      excluded: person.excluded,
    });
  }
  for (const id of assetIds) insertLiveAsset(db, libraryId, { id: id.toHexString() });
  for (const face of fixture.faces) {
    insertFace(db, {
      assetId: assetIds[face.assetIndex]!.toHexString(),
      faceIndex: face.faceIndex,
      personId: face.personIndex === undefined ? null : personIds[face.personIndex]!.toHexString(),
      embedding: face.embedding,
      hidden: face.hidden,
    });
  }
  return prepareSqlite(threshold, testDb(db));
}

/**
 * Run one fixture through both engines and assert the results agree.
 *
 * Centroids are compared exactly, not approximately. The double normalise
 * across the write-then-reload boundary is part of the numeric path, and a
 * version that dropped one of the two passes would still cluster these
 * fixtures the same way while shifting the last bits of every component — so
 * an approximate comparison would let exactly the regression this guards
 * against through.
 */
async function expectParity(fixture: Fixture, threshold = 0.5): Promise<void> {
  using handle = await createTestDatabase('file');
  const assetIds = ascending(fixture.assets);
  const personIds = ascending(fixture.people.length);

  const mongoPass = await runMongo(fixture, assetIds, personIds, threshold);
  const sqlitePass = await runSqlite(handle, fixture, assetIds, personIds, threshold);

  expect(sqlitePass.assignments).toEqual(mongoPass.assignments);
  expect(sqlitePass.seedCount).toBe(mongoPass.seedCount);
  expect(sqlitePass.seedPersonIds).toEqual(mongoPass.seedPersonIds);
  expect(sqlitePass.recomputed).toBe(mongoPass.recomputed);
  expect(sqlitePass.maxAutoIndex).toBe(mongoPass.maxAutoIndex);
  expect(sqlitePass.faces).toEqual(mongoPass.faces);
  expect(sqlitePass.clusters.map((cluster) => cluster.face_count)).toEqual(
    mongoPass.clusters.map((cluster) => cluster.face_count),
  );
  for (const [index, cluster] of mongoPass.clusters.entries()) {
    expect(sqlitePass.clusters[index]!.centroid).toEqual(cluster.centroid);
  }
  expect(sqlitePass.mergeSuggestions).toEqual(mongoPass.mergeSuggestions);
}

describe('prepareClusteringPass: SQLite matches MongoDB', () => {
  test('a cold library, every face unassigned and no seeds', async () => {
    if (!reachable) return;
    await expectParity({
      assets: 3,
      people: [],
      faces: [
        { assetIndex: 0, faceIndex: 0, embedding: nearAxis(0, 0.05) },
        { assetIndex: 0, faceIndex: 1, embedding: nearAxis(7, 0.05) },
        { assetIndex: 1, faceIndex: 0, embedding: nearAxis(0, 0.1) },
        { assetIndex: 2, faceIndex: 0, embedding: nearAxis(7, 0.12) },
      ],
    });
  });

  test('existing people seed the pass and absorb matching faces', async () => {
    if (!reachable) return;
    await expectParity({
      assets: 2,
      people: [
        { name: 'Ada', centroid: nearAxis(0, 0.02), centroidFaceCount: 4 },
        { name: 'Grace', centroid: nearAxis(7, 0.02), centroidFaceCount: 2 },
      ],
      faces: [
        { assetIndex: 0, faceIndex: 0, embedding: nearAxis(0, 0.08) },
        { assetIndex: 1, faceIndex: 0, embedding: nearAxis(7, 0.08) },
        { assetIndex: 1, faceIndex: 1, embedding: nearAxis(40, 0.05) },
      ],
    });
  });

  test('ambiguous near-threshold embeddings, where a normalise drift would show', async () => {
    if (!reachable) return;
    // Twelve vectors whose pairwise scores straddle 0.5 — the regime where a
    // difference of a few bits flips an assignment. Clean orthogonal fixtures
    // cannot catch that; these can.
    await expectParity({
      assets: 4,
      people: [],
      faces: Array.from({ length: 12 }, (_, index) => ({
        assetIndex: index % 4,
        faceIndex: Math.floor(index / 4),
        embedding: pseudoRandom(index + 1),
      })),
    });
  });

  test('a stale centroid is recomputed from its faces before the seeds load', async () => {
    if (!reachable) return;
    // `centroid_face_count: -1` is the force-recompute tag a manual reassignment
    // leaves behind. The pass must rebuild the centroid from the assigned faces
    // and then seed from the rebuilt value — the write-then-reload path.
    await expectParity({
      assets: 3,
      people: [{ name: 'Ada', centroid: nearAxis(0, 0.4), centroidFaceCount: -1 }],
      faces: [
        { assetIndex: 0, faceIndex: 0, embedding: nearAxis(0, 0.03), personIndex: 0 },
        { assetIndex: 1, faceIndex: 0, embedding: nearAxis(0, 0.06), personIndex: 0 },
        { assetIndex: 2, faceIndex: 0, embedding: nearAxis(0, 0.09) },
      ],
    });
  });

  test('hidden faces stay out of both the recompute and the pass', async () => {
    if (!reachable) return;
    await expectParity({
      assets: 3,
      people: [{ name: 'Ada', centroid: nearAxis(0, 0.2), centroidFaceCount: -1 }],
      faces: [
        { assetIndex: 0, faceIndex: 0, embedding: nearAxis(0, 0.03), personIndex: 0 },
        // Assigned but hidden: must not contribute to the rebuilt centroid.
        {
          assetIndex: 1,
          faceIndex: 0,
          embedding: nearAxis(30, 0.03),
          personIndex: 0,
          hidden: true,
        },
        // Unassigned and hidden: must not be clustered.
        { assetIndex: 2, faceIndex: 0, embedding: nearAxis(0, 0.05), hidden: true },
      ],
    });
  });

  test('a person with no remaining faces has their centroid cleared', async () => {
    if (!reachable) return;
    await expectParity({
      assets: 1,
      people: [{ name: 'Ada', centroid: nearAxis(0, 0.05), centroidFaceCount: -1 }],
      faces: [{ assetIndex: 0, faceIndex: 0, embedding: nearAxis(20, 0.05) }],
    });
  });

  test('the auto-name high-water mark comes from the existing "Person N" rows', async () => {
    if (!reachable) return;
    await expectParity({
      assets: 1,
      people: [
        { name: 'Person 3', centroid: nearAxis(0, 0.02), centroidFaceCount: 1 },
        { name: 'Person 11', centroid: nearAxis(7, 0.02), centroidFaceCount: 1 },
        // Not an auto-name, and must not be read as one.
        { name: 'Person Alice', centroid: nearAxis(40, 0.02), centroidFaceCount: 1 },
      ],
      faces: [{ assetIndex: 0, faceIndex: 0, embedding: nearAxis(60, 0.05) }],
    });
  });

  test('merge suggestions agree, including which people are excluded from them', async () => {
    if (!reachable) return;
    // Hidden and excluded people stay clustering seeds but must not be offered
    // as merge candidates, and the two engines have to agree on both halves.
    await expectParity({
      assets: 1,
      people: [
        { name: 'Ada', centroid: nearAxis(0, 0.02), centroidFaceCount: 3 },
        { name: 'Ada again', centroid: nearAxis(0, 0.03), centroidFaceCount: 2 },
        { name: 'Hidden Ada', centroid: nearAxis(0, 0.04), centroidFaceCount: 2, hidden: true },
        { name: 'Excluded Ada', centroid: nearAxis(0, 0.05), centroidFaceCount: 2, excluded: true },
      ],
      faces: [{ assetIndex: 0, faceIndex: 0, embedding: nearAxis(0, 0.06) }],
    });
  });
});
