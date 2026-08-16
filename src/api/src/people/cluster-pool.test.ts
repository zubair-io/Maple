/**
 * Parity + off-thread tests for the clustering pool. The Worker now owns the
 * WHOLE load + compute stage (recompute → load centroids → load unassigned
 * faces → cluster) against its own Mongo handle (#710), so these tests stand
 * up a real Mongo and assert that the worker path produces output
 * bit-identical to running `prepareClusteringPass` in-process.
 *
 * Skip-pass when Mongo is unreachable, mirroring clustering-job.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import type { AssetDoc, AssetFaceDoc } from '../db/schema.ts';
import { prepareClusteringPassOffThread } from './cluster-pool.ts';
import { prepareClusteringPass } from './cluster-load.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';

const TEST_DB = withTestDb(`maple_test_cluster_pool_${process.pid}`);
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

const DIM = 512;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
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
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[cluster-pool.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  // `ensureIndexes` drops/creates indexes on the auth collections; create
  // them first so `users.dropIndex('email_1')` doesn't throw `ns not found`
  // on a fresh DB. Mirrors clustering-job.test.ts.
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
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

/** A perturbed unit vector — `axis` dominant, jitter spread to two others. */
function nearAxis(axis: number, jitter: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[axis] = 1 - jitter;
  v[(axis + 1) % DIM] = jitter / 2;
  v[(axis + 2) % DIM] = jitter / 2;
  return v;
}

async function insertFaces(faces: AssetFaceDoc[]): Promise<ObjectId> {
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

function face(embedding: number[]): AssetFaceDoc {
  return { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9, embedding };
}

/** Deterministic pseudo-random embedding so the "near threshold" parity test
 * is reproducible. Spreads energy across many dims so cosine scores land in
 * the ambiguous 0.4–0.6 band rather than the clean orthogonal extremes the
 * other fixtures use — this is the case most likely to expose a normalize
 * drift between the worker and in-process paths. */
function pseudoRandom(seed: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  let s = seed * 2654435761;
  for (let i = 0; i < DIM; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    v[i] = (s / 0x7fffffff) * 2 - 1;
  }
  return v;
}

describe('prepareClusteringPassOffThread', () => {
  it('matches the in-process stage for a simple same-cluster batch', async () => {
    if (!mongoReachable) return;
    await insertFaces([face(nearAxis(0, 0.05)), face(nearAxis(0, 0.1))]);
    await insertFaces([face(nearAxis(0, 0.15))]);

    // Snapshot the off-thread (worker) result, then reset the DB to the same
    // state and snapshot the in-process result — both must agree.
    const off = await prepareClusteringPassOffThread(0.5);
    expect(off.viaWorker).toBe(true);

    await db!.collection('people').deleteMany({});
    await db!.collection('assets').deleteMany({});
    await insertFaces([face(nearAxis(0, 0.05)), face(nearAxis(0, 0.1))]);
    await insertFaces([face(nearAxis(0, 0.15))]);
    const inproc = await prepareClusteringPass(0.5);

    expect(off.pass.assignments).toEqual(inproc.assignments);
    expect(off.pass.seedCount).toBe(inproc.seedCount);
    expect(off.pass.clusters.map((c) => c.face_count)).toEqual(
      inproc.clusters.map((c) => c.face_count),
    );
    // Centroids must match exactly (Trap: a dropped normalize shifts ULPs).
    for (let k = 0; k < inproc.clusters.length; k += 1) {
      expect(off.pass.clusters[k].centroid).toEqual(inproc.clusters[k].centroid);
    }
  });

  it('matches the in-process stage on ambiguous near-threshold embeddings', async () => {
    if (!mongoReachable) return;
    // 12 deterministic embeddings whose pairwise cosine scores straddle the
    // 0.5 threshold — the regime where a normalize drift between paths would
    // flip an assignment. Orthogonal-axis fixtures can't catch that.
    const faces: AssetFaceDoc[] = [];
    for (let i = 0; i < 12; i += 1) faces.push(face(pseudoRandom(i + 1)));
    await insertFaces(faces);

    const off = await prepareClusteringPassOffThread(0.5);
    expect(off.viaWorker).toBe(true);

    await db!.collection('people').deleteMany({});
    await db!.collection('assets').deleteMany({});
    await insertFaces(faces);
    const inproc = await prepareClusteringPass(0.5);

    expect(off.pass.assignments).toEqual(inproc.assignments);
    expect(off.pass.clusters.length).toBe(inproc.clusters.length);
    for (let k = 0; k < inproc.clusters.length; k += 1) {
      expect(off.pass.clusters[k].centroid).toEqual(inproc.clusters[k].centroid);
      expect(off.pass.clusters[k].face_count).toBe(inproc.clusters[k].face_count);
    }
  });

  // The parity assertions above pass even if the Worker silently fell back to
  // the in-process path (output is identical either way), so they can't prove
  // the load + compute actually left the main thread. The `viaWorker` assertion
  // below is the definitive proof of that. The microtask-drain check is a
  // secondary guard that the work is not synchronous: a Worker round-trip only
  // completes on a `message` event (a macrotask), so its result cannot settle
  // while we drain only microtasks. (The in-process fallback also does async
  // Mongo I/O and likewise wouldn't settle within microtasks, so the drain
  // alone isn't conclusive — `viaWorker` is what distinguishes the two paths.)
  it('runs genuinely off-thread (does not settle within the microtask queue)', async () => {
    if (!mongoReachable) return;
    await insertFaces([face(nearAxis(3, 0.05))]);
    let settled = false;
    const p = prepareClusteringPassOffThread(0.5).then((r) => {
      settled = true;
      return r;
    });
    // Drain microtasks only — never yields to a macrotask, so the worker's
    // reply (and its async Mongo work) can't have been delivered yet.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(settled).toBe(false);
    const r = await p;
    expect(settled).toBe(true);
    expect(r.viaWorker).toBe(true);
  });
});
