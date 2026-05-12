/**
 * People repo tests — real Mongo, skip-pass when unreachable. Mirrors the
 * pattern in `enrichment-route.test.ts` but exercises the repo functions
 * directly (route tests live in `tests/people-route.test.ts`).
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
import type { AssetDoc, AssetFaceDoc, PersonDoc } from "../db/schema.ts";

const TEST_DB = `maple_test_people_repo_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

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
    console.log("[people.repo.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  // Pre-create the auxiliary collections that ensureIndexes touches —
  // some Mongo operations (e.g. dropIndex on a fresh namespace) raise
  // NamespaceNotFound rather than IndexNotFound, and the production
  // code path doesn't need to handle that because real deploys always
  // have these collections populated by the time ensureIndexes runs.
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

function makeFolderObjectId(): ObjectId {
  return new ObjectId();
}

function makeEmbedding(dim: number, seed: number): number[] {
  const out: number[] = new Array(dim);
  for (let i = 0; i < dim; i += 1) {
    // Deterministic-ish per seed — alternating sign keeps norms positive.
    out[i] = Math.sin((i + 1) * seed) * 0.5 + Math.cos((i * 3 + seed) * 0.7) * 0.5;
  }
  return out;
}

async function insertAssetWithFaces(
  faces: AssetFaceDoc[],
): Promise<ObjectId> {
  const doc: AssetDoc = {
    folder_id: makeFolderObjectId(),
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

describe("people.repo — createPerson", () => {
  it("creates a person with a fresh name", async () => {
    if (!mongoReachable) return;
    const { createPerson } = await import("./people.repo.ts");
    const p = await createPerson("Alice");
    expect(p.name).toBe("Alice");
    expect(p._id).toBeInstanceOf(ObjectId);
  });

  it("dedupes case-insensitively (returns the existing row)", async () => {
    if (!mongoReachable) return;
    const { createPerson } = await import("./people.repo.ts");
    const a = await createPerson("Bob");
    const b = await createPerson("BOB");
    const c = await createPerson("bob");
    expect(b._id.toHexString()).toBe(a._id.toHexString());
    expect(c._id.toHexString()).toBe(a._id.toHexString());
    const count = await db!.collection<PersonDoc>("people").countDocuments({
      merged_into: null,
    });
    expect(count).toBe(1);
  });

  it("rejects empty name", async () => {
    if (!mongoReachable) return;
    const { createPerson } = await import("./people.repo.ts");
    await expect(createPerson("   ")).rejects.toThrow(/empty/);
  });
});

describe("people.repo — renamePerson", () => {
  it("renames a person to a new unique name", async () => {
    if (!mongoReachable) return;
    const { createPerson, renamePerson } = await import("./people.repo.ts");
    const p = await createPerson("Carol");
    const result = await renamePerson(p._id, "Caroline");
    expect(result.survivor.name).toBe("Caroline");
    expect(result.mergedFrom).toBeUndefined();
  });

  it("merges on collision: face person_ids are repointed at survivor", async () => {
    if (!mongoReachable) return;
    const { createPerson, renamePerson, assignFaceToPerson } =
      await import("./people.repo.ts");
    const dave = await createPerson("Dave");
    const david = await createPerson("David");
    const asset = await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 10, h: 10 },
        person_id: null,
        confidence: 0.9,
        embedding: makeEmbedding(512, 1),
      },
    ]);
    await assignFaceToPerson(asset, 0, david._id);
    // Rename Dave to "David" — collision with the existing David row.
    const result = await renamePerson(dave._id, "David");
    expect(result.mergedFrom).toBeDefined();
    // Survivor is the older _id (lexicographic min).
    const expectedSurvivor =
      dave._id.toString() < david._id.toString() ? dave._id : david._id;
    expect(result.survivor._id.toHexString()).toBe(expectedSurvivor.toHexString());
    expect(result.survivor.name).toBe("David");
    // Face person_id was repointed to the survivor.
    const faceAsset = await db!
      .collection<AssetDoc>("assets")
      .findOne({ _id: asset });
    expect(faceAsset?.faces?.[0]?.person_id).toBe(
      result.survivor._id.toHexString(),
    );
    // Orphan is marked merged.
    const orphanId = result.mergedFrom!;
    const orphan = await db!.collection<PersonDoc>("people").findOne({
      _id: orphanId,
    });
    expect(orphan?.merged_into?.toHexString()).toBe(
      result.survivor._id.toHexString(),
    );
  });

  it("idempotent rename to same name (case-insensitive)", async () => {
    if (!mongoReachable) return;
    const { createPerson, renamePerson } = await import("./people.repo.ts");
    const p = await createPerson("Eve");
    const r = await renamePerson(p._id, "EVE");
    expect(r.survivor.name).toBe("EVE");
    expect(r.mergedFrom).toBeUndefined();
  });
});

describe("people.repo — listPeople", () => {
  it("returns face counts via aggregation, excludes merged people", async () => {
    if (!mongoReachable) return;
    const { createPerson, renamePerson, listPeople, assignFaceToPerson } =
      await import("./people.repo.ts");
    const a = await createPerson("Anna");
    const b = await createPerson("Beth");
    const c = await createPerson("Cara");
    const asset = await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 10, h: 10 }, person_id: null, confidence: 0.9, embedding: makeEmbedding(512, 2) },
      { bbox: { x: 11, y: 0, w: 10, h: 10 }, person_id: null, confidence: 0.9, embedding: makeEmbedding(512, 3) },
      { bbox: { x: 22, y: 0, w: 10, h: 10 }, person_id: null, confidence: 0.9, embedding: makeEmbedding(512, 4) },
    ]);
    await assignFaceToPerson(asset, 0, a._id);
    await assignFaceToPerson(asset, 1, a._id);
    await assignFaceToPerson(asset, 2, b._id);
    // Merge c into a.
    await renamePerson(c._id, "Anna");
    const list = await listPeople({ withCounts: true });
    // Only live people show up.
    expect(list.map((r) => r.person.name).sort()).toEqual(["Anna", "Beth"]);
    const anna = list.find((r) => r.person.name === "Anna");
    const beth = list.find((r) => r.person.name === "Beth");
    expect(anna?.faceCount).toBe(2);
    expect(beth?.faceCount).toBe(1);
  });

  it("populates coverAbsPath from the cover_asset_id → assets.abs_path join", async () => {
    if (!mongoReachable) return;
    const { createPerson, listPeople } = await import("./people.repo.ts");
    // Three people: one whose cover points at a real asset, one whose
    // cover points at a deleted asset (the doc was removed but the
    // people row still references it), one with no cover_asset_id at
    // all. The first should resolve, the other two stay null.
    const live = await createPerson("Live");
    const orphan = await createPerson("Orphan");
    const noCover = await createPerson("NoCover");
    const liveAsset = await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 10, h: 10 }, person_id: null, confidence: 0.9, embedding: makeEmbedding(512, 8) },
    ]);
    const livePath = (
      await db!.collection<AssetDoc>("assets").findOne({ _id: liveAsset })
    )?.abs_path;
    expect(typeof livePath).toBe("string");
    // Set covers directly. Mixed-case hex on the orphan exercises the
    // safeObjectId normalisation in coverAbsPathByPerson.
    await db!
      .collection<PersonDoc>("people")
      .updateOne({ _id: live._id }, { $set: { cover_asset_id: liveAsset.toHexString() } });
    await db!.collection<PersonDoc>("people").updateOne(
      { _id: orphan._id },
      { $set: { cover_asset_id: new ObjectId().toHexString().toUpperCase() } },
    );

    const list = await listPeople({ withCounts: false });
    const byName = new Map(list.map((r) => [r.person.name, r]));
    expect(byName.get("Live")?.coverAbsPath).toBe(livePath ?? null);
    expect(byName.get("Orphan")?.coverAbsPath).toBeNull();
    expect(byName.get("NoCover")?.coverAbsPath).toBeNull();
  });
});

describe("people.repo — assignFaceToPerson", () => {
  it("sets person_id; null unassigns", async () => {
    if (!mongoReachable) return;
    const { createPerson, assignFaceToPerson } =
      await import("./people.repo.ts");
    const p = await createPerson("Frank");
    const asset = await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 10, h: 10 }, person_id: null, confidence: 0.9, embedding: makeEmbedding(512, 5) },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    let row = await db!.collection<AssetDoc>("assets").findOne({ _id: asset });
    expect(row?.faces?.[0]?.person_id).toBe(p._id.toHexString());
    await assignFaceToPerson(asset, 0, null);
    row = await db!.collection<AssetDoc>("assets").findOne({ _id: asset });
    expect(row?.faces?.[0]?.person_id).toBeNull();
  });

  it("rejects out-of-range face index", async () => {
    if (!mongoReachable) return;
    const { createPerson, assignFaceToPerson } =
      await import("./people.repo.ts");
    const p = await createPerson("Grace");
    const asset = await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 10, h: 10 }, person_id: null, confidence: 0.9, embedding: makeEmbedding(512, 6) },
    ]);
    await expect(assignFaceToPerson(asset, 5, p._id)).rejects.toThrow(/range/);
  });
});

describe("people.repo — deletePerson", () => {
  it("re-points faces to null and removes the row", async () => {
    if (!mongoReachable) return;
    const { createPerson, assignFaceToPerson, deletePerson } =
      await import("./people.repo.ts");
    const p = await createPerson("Henry");
    const asset = await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 10, h: 10 }, person_id: null, confidence: 0.9, embedding: makeEmbedding(512, 7) },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    await deletePerson(p._id);
    const row = await db!.collection<AssetDoc>("assets").findOne({ _id: asset });
    expect(row?.faces?.[0]?.person_id).toBeNull();
    const gone = await db!.collection<PersonDoc>("people").findOne({ _id: p._id });
    expect(gone).toBeNull();
  });
});
