/**
 * re-embed-faces migration tests — real Mongo, skip-pass when unreachable.
 *
 * We stub the detector so the test doesn't need ONNX models on disk; the
 * focus is on the SELECTION + REWRITE behaviour (which faces get
 * re-embedded, what the post-state looks like) rather than the recognizer
 * math itself (covered by face-detector.umeyama.test.ts and the integration
 * harness).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { AssetDoc, AssetFaceDoc } from '../../db/schema.ts';
import type { FaceDetector } from '../../enrichment/face-detector.ts';
import {
  CURRENT_EMBEDDING_VERSION,
  LEGACY_EMBEDDING_VERSION,
} from '../../enrichment/face-models.ts';
import { resolveThumbPathForAsset } from '../../fs/xmp.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { reEmbedFaces, needsReEmbed } from './re-embed-faces.ts';

let libraryId: ObjectId;

const TEST_DB = `maple_test_re_embed_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;

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
    console.log('[re-embed-faces.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  // Reset the global db client so subsequent `assetsCollection()` calls
  // pick up MAPLE_MONGO_DB and hit the test database. We deliberately
  // do NOT call ensureIndexes() — the migration only touches the
  // `assets` collection and ensureIndexes assumes a fully-populated
  // schema (it drops + recreates an index on `users`, which throws
  // NamespaceNotFound on a freshly-dropped test DB).
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'maple-re-embed-'));
  libraryId = new ObjectId();
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), tmpRoot]]));
});

afterEach(() => {
  // beforeEach allocates a fresh tmpRoot per test; without per-test
  // cleanup all but the last would leak under /tmp until the process
  // exits. afterAll's single rmSync only catches whichever happened
  // to be last-assigned.
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  setLibraryRootsForTests(null);
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

function makeStubDetector(embedding: number[]): FaceDetector {
  return {
    detectFaces: async () => [],
    embedFace: async () => new Float32Array(embedding),
  };
}

async function insertAsset(
  faces: AssetFaceDoc[],
  withThumb: boolean = true,
): Promise<{ id: ObjectId; mapleId: string }> {
  // Content-addressed asset: maple_id + fileinfo[0] (with the registered
  // library_id) is what resolveThumbPathForAsset reads. We stage the
  // thumb at the location that helper computes so the migration can find
  // it without depending on the legacy basename-keyed cache.
  const rand = Math.random().toString(36).slice(2);
  const mapleId = `re-embed-test-${rand}`;
  const doc = {
    maple_id: mapleId,
    fileinfo: [
      {
        path: '',
        filename: `${rand}.jpg`,
        library_id: libraryId,
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
  } as unknown as AssetDoc;
  if (withThumb) {
    const thumbPath = resolveThumbPathForAsset(
      doc as unknown as Parameters<typeof resolveThumbPathForAsset>[0],
      new Map([[libraryId.toHexString(), tmpRoot]]),
    );
    if (!thumbPath) throw new Error('test setup: resolveThumbPathForAsset returned null');
    mkdirSync(dirname(thumbPath), { recursive: true });
    // The stub detector never decodes these bytes; any non-empty payload
    // works. The real recognizer would require a JPEG, but the
    // FaceDetector contract is what we're stubbing here.
    writeFileSync(thumbPath, 'stub-jpeg');
  }
  const res = await db!.collection('assets').insertOne(doc);
  return { id: res.insertedId, mapleId };
}

describe('needsReEmbed', () => {
  it('treats missing embedding_version as legacy', () => {
    const face: AssetFaceDoc = {
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      person_id: null,
      confidence: 0.9,
      embedding: [0.1],
    };
    expect(needsReEmbed(face)).toBe(true);
  });

  it('treats explicit legacy tag as needing re-embed', () => {
    const face: AssetFaceDoc = {
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      person_id: null,
      confidence: 0.9,
      embedding: [0.1],
      embedding_version: LEGACY_EMBEDDING_VERSION,
    };
    expect(needsReEmbed(face)).toBe(true);
  });

  it('treats current tag as up-to-date', () => {
    const face: AssetFaceDoc = {
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      person_id: null,
      confidence: 0.9,
      embedding: [0.1],
      embedding_version: CURRENT_EMBEDDING_VERSION,
    };
    expect(needsReEmbed(face)).toBe(false);
  });
});

describe('reEmbedFaces — happy path', () => {
  it('re-embeds legacy faces and stamps current version', async () => {
    if (!mongoReachable) return;
    await db!.collection('assets').deleteMany({});

    // One asset with two legacy faces (no embedding_version) + one
    // already-current face (should be left alone).
    const stub = makeStubDetector([1, 2, 3, 4]);
    const { id } = await insertAsset([
      {
        bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        person_id: null,
        confidence: 0.9,
        embedding: [9, 9, 9, 9],
      },
      {
        bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
        person_id: 'deadbeef00000000deadbeef',
        confidence: 0.85,
        embedding: [9, 9, 9, 9],
        embedding_version: LEGACY_EMBEDDING_VERSION,
      },
      {
        bbox: { x: 0.7, y: 0.7, w: 0.2, h: 0.2 },
        person_id: null,
        confidence: 0.95,
        embedding: [1, 2, 3, 4],
        embedding_version: CURRENT_EMBEDDING_VERSION,
      },
    ]);

    const result = await reEmbedFaces({ detector: stub });
    expect(result.scannedAssets).toBe(1);
    expect(result.updatedAssets).toBe(1);
    expect(result.skippedAssets).toBe(0);
    expect(result.reEmbeddedFaces).toBe(2);
    expect(result.skippedFaces).toBe(0);
    expect(result.aborted).toBe(false);

    const fresh = await db!.collection<AssetDoc>('assets').findOne({ _id: id });
    expect(fresh).not.toBeNull();
    const faces = fresh!.faces ?? [];
    expect(faces).toHaveLength(3);
    expect(faces[0]!.embedding_version).toBe(CURRENT_EMBEDDING_VERSION);
    expect(faces[0]!.embedding).toEqual([1, 2, 3, 4]);
    expect(faces[1]!.embedding_version).toBe(CURRENT_EMBEDDING_VERSION);
    expect(faces[1]!.embedding).toEqual([1, 2, 3, 4]);
    // person_id and bbox preserved — re-embed must not scramble operator state.
    expect(faces[1]!.person_id).toBe('deadbeef00000000deadbeef');
    expect(faces[1]!.bbox).toEqual({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 });
    // The already-current face is untouched.
    expect(faces[2]!.embedding).toEqual([1, 2, 3, 4]);
  });

  it('is idempotent — re-running on a migrated DB is a no-op', async () => {
    if (!mongoReachable) return;
    await db!.collection('assets').deleteMany({});

    const stub = makeStubDetector([0.5, 0.6, 0.7]);
    await insertAsset([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: [9, 9, 9],
      },
    ]);
    const first = await reEmbedFaces({ detector: stub });
    expect(first.reEmbeddedFaces).toBe(1);

    const second = await reEmbedFaces({ detector: stub });
    expect(second.scannedAssets).toBe(0);
    expect(second.updatedAssets).toBe(0);
    expect(second.skippedAssets).toBe(0);
    expect(second.reEmbeddedFaces).toBe(0);
  });

  it('skips faces when the thumb is missing (and counts them)', async () => {
    if (!mongoReachable) return;
    await db!.collection('assets').deleteMany({});

    const stub = makeStubDetector([1, 2, 3]);
    await insertAsset(
      [
        {
          bbox: { x: 0, y: 0, w: 1, h: 1 },
          person_id: null,
          confidence: 0.9,
          embedding: [9, 9, 9],
        },
      ],
      /* withThumb */ false,
    );
    const result = await reEmbedFaces({ detector: stub });
    expect(result.reEmbeddedFaces).toBe(0);
    expect(result.skippedFaces).toBe(1);
    expect(result.skippedAssets).toBe(1);
    expect(result.updatedAssets).toBe(0);
  });

  it('preserves operator edits to other fields (person_id, hidden, bbox)', async () => {
    if (!mongoReachable) return;
    await db!.collection('assets').deleteMany({});

    // Asset with two legacy faces — both need re-embedding, but the
    // first has a person_id assignment and the second is hidden. The
    // re-embed must NOT clobber either piece of operator state.
    const stub = makeStubDetector([7, 7, 7, 7]);
    const { id } = await insertAsset([
      {
        bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
        person_id: 'cafebabe00000000cafebabe',
        confidence: 0.91,
        embedding: [1, 1, 1, 1],
      },
      {
        bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
        person_id: null,
        confidence: 0.88,
        embedding: [2, 2, 2, 2],
        hidden: true,
      },
    ]);

    const result = await reEmbedFaces({ detector: stub });
    expect(result.updatedAssets).toBe(1);
    expect(result.reEmbeddedFaces).toBe(2);

    const fresh = await db!.collection<AssetDoc>('assets').findOne({ _id: id });
    expect(fresh).not.toBeNull();
    const faces = fresh!.faces ?? [];
    expect(faces).toHaveLength(2);
    // Embedding + version refreshed.
    expect(faces[0]!.embedding).toEqual([7, 7, 7, 7]);
    expect(faces[0]!.embedding_version).toBe(CURRENT_EMBEDDING_VERSION);
    expect(faces[1]!.embedding).toEqual([7, 7, 7, 7]);
    expect(faces[1]!.embedding_version).toBe(CURRENT_EMBEDDING_VERSION);
    // Operator state untouched — this is the load-bearing assertion.
    expect(faces[0]!.person_id).toBe('cafebabe00000000cafebabe');
    expect(faces[0]!.bbox).toEqual({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 });
    expect(faces[0]!.confidence).toBe(0.91);
    expect(faces[1]!.hidden).toBe(true);
    expect(faces[1]!.bbox).toEqual({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 });
    expect(faces[1]!.confidence).toBe(0.88);
  });
});

describe('reEmbedFaces — selection predicate', () => {
  it("doesn't touch assets with no faces", async () => {
    if (!mongoReachable) return;
    await db!.collection('assets').deleteMany({});
    await insertAsset([]);
    const stub = makeStubDetector([1, 2]);
    const result = await reEmbedFaces({ detector: stub });
    expect(result.scannedAssets).toBe(0);
    expect(result.updatedAssets).toBe(0);
  });

  it("doesn't touch assets whose faces are all current", async () => {
    if (!mongoReachable) return;
    await db!.collection('assets').deleteMany({});
    await insertAsset([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: [1, 2, 3],
        embedding_version: CURRENT_EMBEDDING_VERSION,
      },
    ]);
    const stub = makeStubDetector([9, 9, 9]);
    const result = await reEmbedFaces({ detector: stub });
    expect(result.scannedAssets).toBe(0);
    expect(result.updatedAssets).toBe(0);
  });
});
