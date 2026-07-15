/**
 * Online clustering tests — real Mongo, skip-pass when unreachable.
 *
 * Embeddings are hand-crafted to land near or far from a known centroid so
 * we can assert deterministic assignment.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { AssetDoc, AssetFaceDoc } from '../db/schema.ts';

const TEST_DB = `maple_test_clustering_${process.pid}`;
// Save originals so afterAll can restore them; mutating process.env here
// would leak into other test files in the same Bun process.
const ORIGINAL_MONGO_URI = process.env.MAPLE_MONGO_URI;
const ORIGINAL_MONGO_DB = process.env.MAPLE_MONGO_DB;

let mongod: MongoMemoryServer | null = null;
let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

const DIM = 512;

async function tryConnect(uri: string): Promise<MongoClient | null> {
  const c = new MongoClient(uri, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

beforeAll(async () => {
  let uri = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

  // Try the provided/default URI first; fall back to an in-process memory
  // server so the suite passes in environments without a local MongoDB.
  mongo = await tryConnect(uri);
  if (!mongo) {
    try {
      mongod = await MongoMemoryServer.create();
      uri = mongod.getUri();
      mongo = await tryConnect(uri);
    } catch {
      console.log(
        '[clustering-job.test] skipping: MongoDB unreachable (both local and memory server)',
      );
      return;
    }
  }

  if (!mongo) {
    console.log('[clustering-job.test] skipping: MongoDB unreachable');
    return;
  }

  mongoReachable = true;
  // Point the lazy-loaded db client at the same instance for the duration of
  // this test file — restored in afterAll.
  process.env.MAPLE_MONGO_URI = uri;
  process.env.MAPLE_MONGO_DB = TEST_DB;

  db = mongo.db(TEST_DB);
  await db.dropDatabase();
  for (const name of ['users', 'credentials', 'invites', 'refresh_tokens', 'challenges']) {
    await db.createCollection(name).catch(() => undefined);
  }
  const { closeDb, ensureIndexes } = await import('../db/client.ts');
  await closeDb();
  await ensureIndexes();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('people').deleteMany({});
  await db!.collection('assets').deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  if (mongod) {
    await mongod.stop();
  }

  // Restore env vars so subsequent test files in the same process see the
  // original configuration.
  if (ORIGINAL_MONGO_URI !== undefined) {
    process.env.MAPLE_MONGO_URI = ORIGINAL_MONGO_URI;
  } else {
    delete process.env.MAPLE_MONGO_URI;
  }
  if (ORIGINAL_MONGO_DB !== undefined) {
    process.env.MAPLE_MONGO_DB = ORIGINAL_MONGO_DB;
  } else {
    delete process.env.MAPLE_MONGO_DB;
  }

  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

/** Build an embedding that is `axis = 1` and zeros elsewhere — orthogonal
 * vectors are easy to reason about for cosine similarity. */
function unitVector(axis: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[axis] = 1;
  return v;
}

/** Slight perturbation of `unitVector(axis)` so two faces of "the same
 * person" land near each other but not bit-identical. */
function nearAxis(axis: number, jitter: number): number[] {
  const v = unitVector(axis);
  v[axis] = 1 - jitter;
  // Spread the missing energy across two other dims so the vector still
  // has a clear primary axis. We don't normalise here — the clustering
  // job does that internally.
  v[(axis + 1) % DIM] = jitter / 2;
  v[(axis + 2) % DIM] = jitter / 2;
  return v;
}

async function insertAssetWithFaces(faces: AssetFaceDoc[]): Promise<ObjectId> {
  const doc: AssetDoc = {
    fileinfo: [
      {
        path: '',
        filename: `${Math.random().toString(36).slice(2, 8)}.jpg`,
        library_id: new ObjectId(),
        deleted_at: null,
      },
    ],
    size: 1024,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    faces,
  };
  const res = await db!.collection('assets').insertOne(doc as AssetDoc);
  return res.insertedId;
}

describe('runOnlineClustering', () => {
  it('assigns close faces to one cluster', async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import('./clustering-job.ts');
    // Three faces close to axis-0 — should land in one auto-named person.
    await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(0, 0.05),
      },
      {
        bbox: { x: 1, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(0, 0.1),
      },
    ]);
    await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(0, 0.15),
      },
    ]);
    const r = await runOnlineClustering();
    expect(r.assigned).toBe(3);
    expect(r.newPeople).toBe(1);
    const people = await db!.collection('people').find({ merged_into: null }).toArray();
    expect(people).toHaveLength(1);
    expect(people[0].name).toMatch(/^Person \d+$/);
  });

  it('creates a new person for a far face', async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import('./clustering-job.ts');
    await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(0, 0.05),
      },
      {
        bbox: { x: 1, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(50, 0.05),
      },
    ]);
    const r = await runOnlineClustering();
    expect(r.assigned).toBe(2);
    expect(r.newPeople).toBe(2);
  });

  it('is idempotent — re-running assigns nothing', async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import('./clustering-job.ts');
    await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(0, 0.05),
      },
      {
        bbox: { x: 1, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(0, 0.1),
      },
    ]);
    const r1 = await runOnlineClustering();
    expect(r1.assigned).toBe(2);
    const r2 = await runOnlineClustering();
    expect(r2.assigned).toBe(0);
    expect(r2.newPeople).toBe(0);
  });

  it('respects an explicit similarity threshold', async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import('./clustering-job.ts');
    // With a high threshold (0.999) the second face shouldn't merge.
    await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(0, 0.05),
      },
      {
        bbox: { x: 1, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(0, 0.5),
      },
    ]);
    const r = await runOnlineClustering({ similarityThreshold: 0.999 });
    expect(r.newPeople).toBe(2);
  });

  it('a hidden person stays a clustering seed — new matching faces flow into it (no new visible cluster)', async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import('./clustering-job.ts');
    const { hidePerson } = await import('./people.repo.ts');

    // First pass: one face near axis-0 forms a single auto-named person.
    await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(0, 0.05),
      },
    ]);
    const r1 = await runOnlineClustering();
    expect(r1.newPeople).toBe(1);
    const seed = await db!.collection('people').findOne({ merged_into: null });
    expect(seed).not.toBeNull();
    const seedId = seed!._id.toHexString();

    // Operator hides that person.
    await hidePerson(seed!._id);

    // A brand-new face matching the SAME axis arrives and clustering re-runs.
    const newAsset = await insertAssetWithFaces([
      {
        bbox: { x: 2, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(0, 0.08),
      },
    ]);
    const r2 = await runOnlineClustering();

    // The new face joined the hidden seed; NO new person was created.
    expect(r2.assigned).toBe(1);
    expect(r2.newPeople).toBe(0);
    const newRow = await db!.collection<AssetDoc>('assets').findOne({ _id: newAsset });
    expect(newRow?.faces?.[0]?.person_id).toBe(seedId);

    // The seed is still the only (non-merged) person AND still hidden.
    const all = await db!.collection('people').find({ merged_into: null }).toArray();
    expect(all).toHaveLength(1);
    expect(all[0]._id.toHexString()).toBe(seedId);
    expect(all[0].hidden).toBe(true);
  });

  it('seeds cover_asset_id on newly-created people', async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import('./clustering-job.ts');
    const assetId = await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(11, 0.05),
      },
    ]);
    await runOnlineClustering();
    const person = await db!.collection('people').findOne({ merged_into: null });
    expect(person?.cover_asset_id).toBe(assetId.toHexString());
  });

  it("seeds cover_bbox on newly-created people (captures the seeding face's bbox)", async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import('./clustering-job.ts');
    const bbox = { x: 0.25, y: 0.15, w: 0.4, h: 0.5 };
    await insertAssetWithFaces([
      { bbox, person_id: null, confidence: 0.9, embedding: nearAxis(31, 0.05) },
    ]);
    await runOnlineClustering();
    const person = await db!.collection('people').findOne({ merged_into: null });
    expect(person?.cover_bbox).toEqual(bbox);
  });

  it('backfill heals rows that have cover_asset_id but no cover_bbox', async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import('./clustering-job.ts');
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');
    const p = await createPerson('Penny');
    const bbox = { x: 0.5, y: 0.5, w: 0.25, h: 0.25 };
    const assetId = await insertAssetWithFaces([
      { bbox, person_id: null, confidence: 0.9, embedding: nearAxis(33, 0.05) },
    ]);
    await assignFaceToPerson(assetId, 0, p._id);
    // Simulate a row from before cover_bbox shipped — has the asset id
    // but no bbox.
    await db!.collection('people').updateOne(
      { _id: p._id },
      {
        $set: { cover_asset_id: assetId.toHexString() },
        $unset: { cover_bbox: '' },
      },
    );
    await runOnlineClustering();
    const fresh = await db!.collection('people').findOne({ _id: p._id });
    expect(fresh?.cover_bbox).toEqual(bbox);
  });

  it("hidden faces stay out of clustering — won't reappear under any person", async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import('./clustering-job.ts');
    const { hideFace } = await import('./people.repo.ts');
    const assetId = await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(41, 0.05),
      },
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(41, 0.1),
      },
    ]);
    // Hide one face before any clustering — the unassigned-faces loader
    // should skip it.
    await hideFace(assetId, 1);
    const r = await runOnlineClustering();
    // Only one face should land in a new cluster.
    expect(r.assigned).toBe(1);
    expect(r.newPeople).toBe(1);
    // Re-running should not pick up the hidden face either.
    const r2 = await runOnlineClustering();
    expect(r2.assigned).toBe(0);
    const row = await db!.collection<AssetDoc>('assets').findOne({ _id: assetId });
    expect(row?.faces?.[1]?.hidden).toBe(true);
    expect(row?.faces?.[1]?.person_id).toBeNull();
  });

  it('backfills cover_asset_id on people that have assigned faces but no cover', async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import('./clustering-job.ts');
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');
    // Operator-created person with no cover yet — same shape as a row
    // produced by the old (pre-fix) clustering path.
    const p = await createPerson('Mary');
    const assetId = await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(13, 0.05),
      },
    ]);
    await assignFaceToPerson(assetId, 0, p._id);
    // No new unassigned faces — clustering will skip the assignment loop
    // but still run the backfill at the end.
    await runOnlineClustering();
    const fresh = await db!.collection('people').findOne({ _id: p._id });
    expect(fresh?.cover_asset_id).toBe(assetId.toHexString());
  });

  it('backfill picks the highest-confidence face per person', async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import('./clustering-job.ts');
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');
    const p = await createPerson('Nina');
    // Three assets, each with a face assigned to Nina at different
    // confidences. The backfill should pick the highest-confidence asset
    // (mid) regardless of insertion order.
    const lowConfAsset = await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.2,
        embedding: nearAxis(15, 0.05),
      },
    ]);
    const highConfAsset = await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.95,
        embedding: nearAxis(15, 0.05),
      },
    ]);
    const midConfAsset = await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.6,
        embedding: nearAxis(15, 0.05),
      },
    ]);
    await assignFaceToPerson(lowConfAsset, 0, p._id);
    await assignFaceToPerson(highConfAsset, 0, p._id);
    await assignFaceToPerson(midConfAsset, 0, p._id);
    await runOnlineClustering();
    const fresh = await db!.collection('people').findOne({ _id: p._id });
    expect(fresh?.cover_asset_id).toBe(highConfAsset.toHexString());
  });

  it('backfill migrates legacy cover_face_id rows to cover_asset_id', async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import('./clustering-job.ts');
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');
    const p = await createPerson('Olive');
    const assetId = await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.85,
        embedding: nearAxis(17, 0.05),
      },
    ]);
    await assignFaceToPerson(assetId, 0, p._id);
    // Simulate a row from the earlier draft that only has the legacy field.
    await db!
      .collection('people')
      .updateOne({ _id: p._id }, { $set: { cover_face_id: 'deadbeefdeadbeefdeadbeef' } });
    await runOnlineClustering();
    const fresh = await db!.collection('people').findOne({ _id: p._id });
    expect(fresh?.cover_asset_id).toBe(assetId.toHexString());
    expect(fresh?.cover_face_id).toBeUndefined();
  });
});

describe('recomputeCentroids', () => {
  it('refreshes centroid from assigned face embeddings', async () => {
    if (!mongoReachable) return;
    const { recomputeCentroids } = await import('./clustering-job.ts');
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');
    const p = await createPerson('Iris');
    const asset = await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(7, 0.05),
      },
      {
        bbox: { x: 1, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(7, 0.1),
      },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    await assignFaceToPerson(asset, 1, p._id);
    await recomputeCentroids();
    const fresh = await db!.collection('people').findOne({ _id: p._id });
    expect(fresh?.centroid_face_count).toBe(2);
    // Centroid's primary axis should be axis 7.
    const centroid = fresh?.centroid as number[];
    expect(centroid).toBeDefined();
    expect(centroid.length).toBe(DIM);
    let max = -Infinity;
    let maxIndex = -1;
    for (let i = 0; i < DIM; i += 1) {
      if (centroid[i] > max) {
        max = centroid[i];
        maxIndex = i;
      }
    }
    expect(maxIndex).toBe(7);
  });
});

describe('prepareClusteringPass — merge suggestions', () => {
  it('suggests the best-matching other live, non-hidden person above threshold', async () => {
    if (!mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { prepareClusteringPass, EMBEDDING_DIM } = await import('./cluster-load.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person A');
    const b = await createPerson('Person B');
    const centroid = new Array(EMBEDDING_DIM).fill(0);
    centroid[0] = 1;
    await peopleC.updateOne({ _id: a._id }, { $set: { centroid, centroid_face_count: 5 } });
    await peopleC.updateOne({ _id: b._id }, { $set: { centroid, centroid_face_count: 5 } });

    const pass = await prepareClusteringPass();
    const forA = pass.mergeSuggestions.find((s) => s.personIdHex === a._id.toHexString());
    expect(forA?.suggestedPersonIdHex).toBe(b._id.toHexString());
    expect(forA?.score).toBeCloseTo(1, 5);
  });

  it('excludes a hidden person from suggestions', async () => {
    if (!mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { prepareClusteringPass, EMBEDDING_DIM } = await import('./cluster-load.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person C');
    const hiddenB = await createPerson('Person D');
    const centroid = new Array(EMBEDDING_DIM).fill(0);
    centroid[0] = 1;
    await peopleC.updateOne({ _id: a._id }, { $set: { centroid, centroid_face_count: 5 } });
    await peopleC.updateOne(
      { _id: hiddenB._id },
      { $set: { centroid, centroid_face_count: 5, hidden: true } },
    );

    const pass = await prepareClusteringPass();
    const forA = pass.mergeSuggestions.find((s) => s.personIdHex === a._id.toHexString());
    expect(forA).toBeUndefined();
  });

  it('excludes a dismissed pair', async () => {
    if (!mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { prepareClusteringPass, EMBEDDING_DIM } = await import('./cluster-load.ts');
    const { peopleCollection, personMergeDismissalsCollection } = await import('../db/client.ts');
    const { sortedPairKey } = await import('./people-merge-suggestions.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person E');
    const b = await createPerson('Person F');
    const centroid = new Array(EMBEDDING_DIM).fill(0);
    centroid[0] = 1;
    await peopleC.updateOne({ _id: a._id }, { $set: { centroid, centroid_face_count: 5 } });
    await peopleC.updateOne({ _id: b._id }, { $set: { centroid, centroid_face_count: 5 } });

    const dismissalsC = await personMergeDismissalsCollection();
    await dismissalsC.insertOne({
      pair: sortedPairKey(a._id.toHexString(), b._id.toHexString()),
      created_at: new Date().toISOString(),
    });

    const pass = await prepareClusteringPass();
    const forA = pass.mergeSuggestions.find((s) => s.personIdHex === a._id.toHexString());
    expect(forA).toBeUndefined();
  });
});

describe('runOnlineClustering — merge suggestion persistence', () => {
  it('writes suggested_merge_person_id/score for a qualifying pair, and self-heals to null once the match is hidden', async () => {
    if (!mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const { runOnlineClustering, EMBEDDING_DIM } = await import('./clustering-job.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person G');
    const b = await createPerson('Person H');
    const c = await createPerson('Person I');
    const matching = new Array(EMBEDDING_DIM).fill(0);
    matching[0] = 1;
    const distinct = new Array(EMBEDDING_DIM).fill(0);
    distinct[1] = 1;
    await peopleC.updateOne(
      { _id: a._id },
      { $set: { centroid: matching, centroid_face_count: 5 } },
    );
    await peopleC.updateOne(
      { _id: b._id },
      { $set: { centroid: matching, centroid_face_count: 5 } },
    );
    await peopleC.updateOne(
      { _id: c._id },
      { $set: { centroid: distinct, centroid_face_count: 5 } },
    );

    // No unassigned faces this run — purely exercises the merge-suggestion
    // write side against the manually-seeded centroids above. (Two people
    // scoring above the merge-suggestion threshold, while still being
    // separate people, is only reachable in practice via centroid drift
    // across many faces — setting centroids directly is the deterministic
    // way to exercise the write-side wiring in isolation; Task 3 already
    // covers the compute side the same way.)
    await runOnlineClustering();

    const freshA = await peopleC.findOne({ _id: a._id });
    const freshB = await peopleC.findOne({ _id: b._id });
    const freshC = await peopleC.findOne({ _id: c._id });
    expect(freshA?.suggested_merge_person_id?.toHexString()).toBe(b._id.toHexString());
    expect(freshA?.suggested_merge_score).toBeCloseTo(1, 5);
    expect(freshB?.suggested_merge_person_id?.toHexString()).toBe(a._id.toHexString());
    expect(freshC?.suggested_merge_person_id ?? null).toBeNull();

    // Hide B, re-run: A's suggestion self-heals to null (its only
    // qualifying match is now excluded from the pass).
    await peopleC.updateOne({ _id: b._id }, { $set: { hidden: true } });
    await runOnlineClustering();
    const afterHide = await peopleC.findOne({ _id: a._id });
    expect(afterHide?.suggested_merge_person_id ?? null).toBeNull();
    expect(afterHide?.suggested_merge_score ?? null).toBeNull();
  });
});

describe('runOnlineClustering — meili reindex trigger', () => {
  it('re-queues the assets it assigned for the meili stage', async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import('./clustering-job.ts');
    const asset = await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(0, 0.05),
      },
    ]);
    // Pretend the asset was already meili-indexed at v6.
    await db!
      .collection('assets')
      .updateOne({ _id: asset }, { $set: { 'stages.meili.version': 6 } });
    await runOnlineClustering();
    // The reindex marker is fire-and-forget; poll for the version reset.
    let version: unknown = 6;
    for (let i = 0; i < 20; i += 1) {
      const row = await db!.collection('assets').findOne({ _id: asset });
      version = (row as { stages?: { meili?: { version?: unknown } } }).stages?.meili?.version;
      if (version === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(version).toBe(0);
  });
});
