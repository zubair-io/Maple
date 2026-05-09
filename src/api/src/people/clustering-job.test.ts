/**
 * Online clustering tests — real Mongo, skip-pass when unreachable.
 *
 * Embeddings are hand-crafted to land near or far from a known centroid so
 * we can assert deterministic assignment.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { MongoClient, ObjectId, type Db } from "mongodb";
import type { AssetDoc, AssetFaceDoc } from "../db/schema.ts";

const TEST_DB = `maple_test_clustering_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

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
    await c.db("admin").command({ ping: 1 });
    return c;
  } catch {
    try { await c.close(); } catch {}
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log("[clustering-job.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  for (const name of [
    "users",
    "credentials",
    "invites",
    "refresh_tokens",
    "challenges",
  ]) {
    await db.createCollection(name).catch(() => undefined);
  }
  const { closeDb, ensureIndexes } = await import("../db/client.ts");
  await closeDb();
  await ensureIndexes();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection("people").deleteMany({});
  await db!.collection("assets").deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import("../db/client.ts");
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

async function insertAssetWithFaces(
  faces: AssetFaceDoc[],
): Promise<ObjectId> {
  const doc: AssetDoc = {
    folder_id: new ObjectId(),
    filename: `${Math.random().toString(36).slice(2, 8)}.jpg`,
    abs_path: `/tmp/maple-test/${Math.random().toString(36).slice(2)}.jpg`,
    size: 1024,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: "",
    indexed_at: new Date().toISOString(),
    faces,
  };
  const res = await db!.collection("assets").insertOne(doc as AssetDoc);
  return res.insertedId;
}

describe("runOnlineClustering", () => {
  it("assigns close faces to one cluster", async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import("./clustering-job.ts");
    // Three faces close to axis-0 — should land in one auto-named person.
    await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9, embedding: nearAxis(0, 0.05) },
      { bbox: { x: 1, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9, embedding: nearAxis(0, 0.1) },
    ]);
    await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9, embedding: nearAxis(0, 0.15) },
    ]);
    const r = await runOnlineClustering();
    expect(r.assigned).toBe(3);
    expect(r.newPeople).toBe(1);
    const people = await db!.collection("people").find({ merged_into: null }).toArray();
    expect(people).toHaveLength(1);
    expect(people[0].name).toMatch(/^Person \d+$/);
  });

  it("creates a new person for a far face", async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import("./clustering-job.ts");
    await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9, embedding: nearAxis(0, 0.05) },
      { bbox: { x: 1, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9, embedding: nearAxis(50, 0.05) },
    ]);
    const r = await runOnlineClustering();
    expect(r.assigned).toBe(2);
    expect(r.newPeople).toBe(2);
  });

  it("is idempotent — re-running assigns nothing", async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import("./clustering-job.ts");
    await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9, embedding: nearAxis(0, 0.05) },
      { bbox: { x: 1, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9, embedding: nearAxis(0, 0.1) },
    ]);
    const r1 = await runOnlineClustering();
    expect(r1.assigned).toBe(2);
    const r2 = await runOnlineClustering();
    expect(r2.assigned).toBe(0);
    expect(r2.newPeople).toBe(0);
  });

  it("respects an explicit similarity threshold", async () => {
    if (!mongoReachable) return;
    const { runOnlineClustering } = await import("./clustering-job.ts");
    // With a high threshold (0.999) the second face shouldn't merge.
    await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9, embedding: nearAxis(0, 0.05) },
      { bbox: { x: 1, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9, embedding: nearAxis(0, 0.5) },
    ]);
    const r = await runOnlineClustering({ similarityThreshold: 0.999 });
    expect(r.newPeople).toBe(2);
  });
});

describe("recomputeCentroids", () => {
  it("refreshes centroid from assigned face embeddings", async () => {
    if (!mongoReachable) return;
    const { recomputeCentroids } = await import("./clustering-job.ts");
    const { createPerson, assignFaceToPerson } = await import("./people.repo.ts");
    const p = await createPerson("Iris");
    const asset = await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9, embedding: nearAxis(7, 0.05) },
      { bbox: { x: 1, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9, embedding: nearAxis(7, 0.1) },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    await assignFaceToPerson(asset, 1, p._id);
    await recomputeCentroids();
    const fresh = await db!.collection("people").findOne({ _id: p._id });
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
