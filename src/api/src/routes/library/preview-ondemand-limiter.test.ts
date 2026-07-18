// preview-ondemand-limiter.test.ts (route-level)
//
// Integration coverage for #2012: `GET /api/preview/:slug/*` must route a
// cache-miss regeneration through `previewOndemandLimiter()` so a burst of
// near-simultaneous requests (e.g. opening a large folder in Browse right
// after the #2006 AVIF/path-key migration) never runs more than the
// configured cap's worth of decode+encode jobs concurrently.
//
// `generatePreview` is faked with a slow, concurrency-tracking implementation
// so this never touches sharp/libraw — via `spyOn` on the previewer module
// namespace, NOT `mock.module`. #2032: the previous `mock.module`-based fake
// leaked out of this file on CI's (linux) test-file collection order — the
// `afterAll` restore did not repoint `workers/stages/preview.ts`'s
// already-captured `generatePreview` binding in Bun's shared module registry,
// so the preview STAGE tests later in the run invoked THIS file's fake, which
// wrote literal `generated-<n>` text bytes as their "preview" and made
// `sharp().metadata()` fail with "unsupported image format" (deterministically
// red on CI, green on macOS where collection order differs). `spyOn` patches
// the one export in place and `mockRestore()` reverts it for every importer —
// the same leak-proof pattern `worker-status.repo.test.ts` documents for
// db/client. Kept in its own file so the fake's lifetime stays trivially
// scoped to this file's beforeAll/afterAll.

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';

const TEST_DB = `maple_test_preview_ondemand_route_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import {
  previewOndemandLimiter,
  _resetPreviewOndemandLimiterForTests,
} from '../../indexer/preview-ondemand-limiter.ts';
import { getDb, closeDb } from '../../db/client.ts';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpDir = '';
let libraryId = new ObjectId();

let activeGenerations = 0;
let peakConcurrent = 0;
let completedCount = 0;

const previewerModule = await import('../../indexer/previewer.ts');

/** Simulated decode+AVIF-encode: tracks concurrency, writes a dummy file so
 * the route's subsequent read succeeds, never touches sharp/libraw. */
async function fakeGeneratePreview(_absPath: string, previewPath: string): Promise<void> {
  activeGenerations++;
  peakConcurrent = Math.max(peakConcurrent, activeGenerations);
  await new Promise((r) => setTimeout(r, 25));
  await mkdir(join(previewPath, '..'), { recursive: true });
  await writeFile(previewPath, `generated-${completedCount}`);
  activeGenerations--;
  completedCount++;
}

// Patch the one export in place — every importer (including `previewRoutes`'s
// own `generatePreview` binding) calls through the namespace slot, and
// `mockRestore()` in `afterAll` reverts it for every importer. See the module
// doc for why this must NOT be `mock.module` (#2032 leak).
const generatePreviewSpy = spyOn(previewerModule, 'generatePreview').mockImplementation(
  fakeGeneratePreview,
);

const { previewRoutes } = await import('./preview.ts');
const { Elysia } = await import('elysia');
const app = new Elysia().use(previewRoutes);

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    await c.close().catch(() => {});
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) return;
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  // Force the app's shared `getDb()` singleton to drop whatever connection an
  // earlier test file in this same `bun test` process left cached and
  // reconnect against THIS file's `MAPLE_MONGO_DB` — `getDb()` only re-reads
  // the env var when its cached `_db` is null (see its own doc), so a prior
  // file's still-open connection would otherwise silently serve
  // `loadLibraryRoots()` / `findAssetByAddress` against the WRONG database
  // here. Mirrors the same guard in `fs-previews.test.ts`.
  await closeDb().catch(() => {});
  await getDb();
  tmpDir = await mkdtemp(join(tmpdir(), 'maple-preview-ondemand-'));
  libraryId = new ObjectId();
  // `resolveAddress` (slug → root) AND `cachePathForAsset` (library_id →
  // root, used to resolve where the on-demand miss should write) both
  // resolve via the SAME `folders`-collection-backed cache
  // (`libraries.cache.ts`'s `loadCache()`) — a real DB doc with a `slug`
  // populates both `byId` and `bySlug` in one read (see `fs-previews.test.ts`
  // for the identical setup on the path-keyed route).
  await db.collection('folders').insertOne({
    _id: libraryId,
    path: tmpDir,
    slug: 'ondemandlib',
    label: 'Ondemand Test',
  });
  invalidateLibraryRoots();
});

beforeEach(async () => {
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
  activeGenerations = 0;
  peakConcurrent = 0;
  completedCount = 0;
  _resetPreviewOndemandLimiterForTests();
  invalidateLibraryRoots();
});

afterAll(async () => {
  generatePreviewSpy.mockRestore(); // restore for sibling test files — see module doc
  if (mongo) {
    await mongo
      .db(TEST_DB)
      .dropDatabase()
      .catch(() => {});
    await mongo.close().catch(() => {});
  }
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  invalidateLibraryRoots();
  await closeDb().catch(() => {});
});

describe('GET /preview/:slug/* — on-demand regeneration is concurrency-bounded (#2012)', () => {
  it('never runs more concurrent regenerations than the configured cap, across a burst of cache-miss requests', async () => {
    if (!mongoReachable) return; // skip-if-unreachable

    previewOndemandLimiter().setLimit(3);

    const FILE_COUNT = 9;
    const filenames = Array.from({ length: FILE_COUNT }, (_, i) => `burst-${i}.jpg`);
    await db!.collection('assets').insertMany(
      filenames.map((filename) => ({
        maple_id: new ObjectId().toHexString(),
        fileinfo: [
          { library_id: libraryId, path: '', filename, deleted_at: null, missing_since: null },
        ],
        deleted_at: null,
      })) as never[],
    );
    await Promise.all(filenames.map((f) => writeFile(join(tmpDir, f), 'source-bytes')));

    // Fire every request near-simultaneously — a synchronized burst, exactly
    // the migration scenario #2012 is guarding against.
    const responses = await Promise.all(
      filenames.map((f) => app.handle(new Request(`http://localhost/preview/ondemandlib/${f}`))),
    );

    for (const res of responses) expect(res.status).toBe(200);
    expect(completedCount).toBe(FILE_COUNT);
    expect(peakConcurrent).toBeLessThanOrEqual(3);
    // Sanity: real overlap happened, not accidental full serialization.
    expect(peakConcurrent).toBeGreaterThan(1);
  });

  it('does not gate a warm cache read through the limiter (no generation call at all)', async () => {
    if (!mongoReachable) return;

    previewOndemandLimiter().setLimit(1);
    const mapleId = new ObjectId().toHexString();
    await db!.collection('assets').insertOne({
      maple_id: mapleId,
      fileinfo: [
        {
          library_id: libraryId,
          path: '',
          filename: 'warm.jpg',
          deleted_at: null,
          missing_since: null,
        },
      ],
      deleted_at: null,
    } as never);
    await writeFile(join(tmpDir, 'warm.jpg'), 'source-bytes');
    const previewPath = join(tmpDir, '.maple', 'previews', 'warm.jpg.avif');
    await mkdir(join(previewPath, '..'), { recursive: true });
    await writeFile(previewPath, 'already-cached-bytes');

    const res = await app.handle(new Request('http://localhost/preview/ondemandlib/warm.jpg'));
    expect(res.status).toBe(200);
    expect(completedCount).toBe(0); // generatePreview never invoked — file already present
  });
});
