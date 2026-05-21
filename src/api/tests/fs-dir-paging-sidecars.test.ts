/**
 * Issue #6 of PR #66 review: paged `/api/fs/dir` responses must pair
 * sidecars to their indexed image even when the image and the sidecar
 * land on different pages of the slice.
 *
 * Setup: 200 images + 200 paired sidecars in one directory (400 visible
 * names). At limit=200 the slice boundary falls in the middle, so
 * legacy code would build `imageBaseToAsset` from only the 200
 * slice-local files and drop every sidecar whose image lives on the
 * other page.
 *
 * Real Mongo; skip-passes if MongoDB is unreachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { pendingEnrichment } from '../src/db/schema.ts';

const TEST_DB = `maple_test_fs_dir_paging_sidecars_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

// Small N so we can use limit=1 (forces every sidecar onto a page whose
// images[] is empty) without making the test run hundreds of requests.
const N = 20;

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let assetIDsByBase: Map<string, string>;

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

describe('GET /api/fs/dir — paged sidecar pairing across page boundaries', () => {
  beforeAll(async () => {
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) {
      console.log('[fs-dir-paging-sidecars.test] skipping: MongoDB unreachable at', MONGO_URI);
      return;
    }

    db = mongo!.db(TEST_DB);
    await db.dropDatabase();

    // Reset the singleton so the route's assetsCollection() reads the test DB.
    const { closeDb } = await import('../src/db/client.ts');
    await closeDb();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-fp-paging-sidecars-'));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;

    // Write N RAW files plus N matching XMP sidecars; index every RAW
    // in Mongo so the route sees a paired asset for each sidecar.
    // Post drop-abs-path-2026-05-21: assets carry `fileinfo[]` and the
    // browse listing resolves the absolute path via the libraries
    // cache, so the seeded folder must match `realTmpRoot`.
    assetIDsByBase = new Map<string, string>();
    const folderId = new ObjectId();
    await db.collection('folders').insertOne({
      _id: folderId,
      path: realTmpRoot,
      label: 'paging-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
    const docs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < N; i++) {
      const base = `IMG_${String(i).padStart(4, '0')}`;
      const rawName = `${base}.ARW`;
      const xmpName = `${base}.xmp`;
      const rawPath = path.join(realTmpRoot, rawName);
      const xmpPath = path.join(realTmpRoot, xmpName);
      await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));
      await fs.writeFile(xmpPath, '<x:xmpmeta/>');
      const id = new ObjectId();
      assetIDsByBase.set(base, id.toHexString());
      docs.push({
        _id: id,
        fileinfo: [{ library_id: folderId, path: '', filename: rawName, deleted_at: null }],
        size: 3,
        mtime: Date.now(),
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: new Date().toISOString(),
        enrichment: pendingEnrichment(),
        place: null,
        faces: [],
        description: null,
        ocr_text: null,
        search_blob: '',
      });
    }
    await db.collection('assets').insertMany(docs as never);
  });

  afterAll(async () => {
    delete process.env.MAPLE_ROOTS;
    if (tmpRoot) {
      try {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      } catch {}
    }
    if (mongo && mongoReachable) {
      try {
        await mongo.db(TEST_DB).dropDatabase();
      } catch {}
      try {
        await mongo.close();
      } catch {}
    }
    try {
      const { closeDb } = await import('../src/db/client.ts');
      await closeDb();
    } catch {}
    if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
  });

  it('every sidecar across paged responses resolves its asset_id', async () => {
    if (!mongoReachable) return;
    const { fsRoutes } = await import('../src/routes/fs.ts');

    // localeCompare interleaves names: IMG_0000.ARW < IMG_0000.xmp <
    // IMG_0001.ARW < IMG_0001.xmp < … so any limit ≥ 2 keeps each
    // RAW/sidecar pair on the same page and the per-slice imageBaseToAsset
    // alone would resolve them — defeating the test. limit=1 puts every
    // sidecar on a page whose images[] is empty, which is the only
    // structure that exercises the global-map cross-page resolution.
    const seen = new Map<string, string>(); // sidecar name → asset_id
    let cursor: string | undefined = undefined;
    let pageCount = 0;
    const maxPages = N * 2 + 5;
    do {
      const qs = new URLSearchParams({
        path: realTmpRoot,
        limit: '1',
      });
      if (cursor) qs.set('cursor', cursor);
      const url = `http://localhost/api/fs/dir?${qs.toString()}`;
      const res = await fsRoutes.handle(new Request(url));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        images: Array<{ name: string }>;
        sidecars: Array<{ name: string; asset_id: string }>;
        next_cursor?: string;
      };
      for (const s of body.sidecars) {
        seen.set(s.name, s.asset_id);
      }
      // Critical structural assertion: a sidecar-only page must still
      // resolve its sidecar. Pre-fix, body.images.length===0 ⇒
      // imageBaseToAsset empty ⇒ sidecar dropped, so seen.size would
      // be 0 at this point.
      cursor = body.next_cursor;
      pageCount++;
      if (pageCount > maxPages) throw new Error("paging didn't terminate");
    } while (cursor);

    // Confirm structurally that pagination really did split most pairs
    // (we expect 2N pages total — N image-only pages and N sidecar-only
    // pages). Without the fix every sidecar-only page would drop its
    // sidecar and seen.size would be 0.
    expect(pageCount).toBe(2 * N);
    expect(seen.size).toBe(N);
    for (let i = 0; i < N; i++) {
      const base = `IMG_${String(i).padStart(4, '0')}`;
      const expected = assetIDsByBase.get(base);
      expect(expected).toBeDefined();
      const got = seen.get(`${base}.xmp`);
      expect(got).toBe(expected!);
    }
  });
});
