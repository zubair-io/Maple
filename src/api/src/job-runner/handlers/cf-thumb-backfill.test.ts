/**
 * cf_thumb_backfill handler integration tests. Real Mongo + real tmp
 * filesystem (skip-pass when Mongo is unreachable, mirroring every other
 * DB-backed suite in this repo). `fetch` is stubbed globally rather than
 * mocking `r2-client.ts` — same technique `thumb.test.ts` uses for the
 * live-upload hook, since `r2-client.ts` ultimately calls `fetch`.
 */

import { describe, expect, it, beforeAll, afterAll, afterEach, beforeEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { cfThumbBackfillHandler } from './cf-thumb-backfill.ts';
import type { JobHandlerContext } from './index.ts';

const TEST_DB = `maple_test_cf_thumb_backfill_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
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

function noopCtx(overrides: Partial<JobHandlerContext> = {}): JobHandlerContext {
  return {
    jobId: new ObjectId(),
    reportProgress: async () => undefined,
    shouldCancel: async () => false,
    ...overrides,
  };
}

const CF_CONFIG = {
  enabled: true,
  account_id: 'acct123',
  bucket: 'maple-thumbs',
  access_key_id: 'AKIAEXAMPLE',
  secret_access_key: 'secretexample',
};

describe('cf_thumb_backfill handler', () => {
  let mongo: MongoClient | null = null;
  let mongoReachable = false;
  let db: Db | null = null;
  let dir: string;
  let libId: ObjectId;
  const realFetch = globalThis.fetch;

  function stubFetch(status: number): void {
    globalThis.fetch = (async () => new Response('', { status })) as unknown as typeof fetch;
  }

  async function makePendingAsset(filename: string, mapleId: string, opts?: { noThumb?: boolean }) {
    const relDir = 'vacation';
    if (!opts?.noThumb) {
      const thumbDir = path.join(dir, relDir, '.maple', 'thumbs');
      await mkdir(thumbDir, { recursive: true });
      await writeFile(path.join(thumbDir, `${mapleId}.jpg`), Buffer.from('fake-jpeg-bytes'));
    }
    const doc = {
      _id: new ObjectId(),
      fileinfo: [{ path: relDir, filename, library_id: libId, deleted_at: null }],
      maple_id: mapleId,
      cf_thumb_synced_at: null,
    };
    await db!.collection('assets').insertOne(doc as never);
    return doc;
  }

  beforeAll(async () => {
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) {
      console.log('[cf-thumb-backfill.test] skipping: MongoDB unreachable');
      return;
    }
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    const { closeDb } = await import('../../db/client.ts');
    await closeDb();
    dir = await mkdtemp(path.join(os.tmpdir(), 'cf-thumb-backfill-'));
    const { foldersCollection } = await import('../../db/client.ts');
    const { invalidateLibraryRoots } = await import('../../indexer/libraries.cache.ts');
    libId = new ObjectId();
    const folders = await foldersCollection();
    await folders.insertOne({
      _id: libId,
      slug: 'backfill-test-lib',
      path: dir,
      label: 'backfill-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    invalidateLibraryRoots();
  });

  beforeEach(async () => {
    if (!mongoReachable) return;
    await db!.collection('assets').deleteMany({});
    await db!
      .collection('app_settings')
      .updateOne({ _id: 'cloudflare' } as never, { $set: { config: CF_CONFIG } }, { upsert: true });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    if (mongoReachable) {
      const { closeDb } = await import('../../db/client.ts');
      await closeDb();
      try {
        await mongo!.db(TEST_DB).dropDatabase();
      } catch {}
      try {
        await mongo!.close();
      } catch {}
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uploads every pending asset and stamps cf_thumb_synced_at', async () => {
    if (!mongoReachable) return;
    stubFetch(200);
    const a = await makePendingAsset('a.jpg', 'a'.repeat(32));
    const b = await makePendingAsset('b.jpg', 'b'.repeat(32));

    const out = await cfThumbBackfillHandler.run({}, noopCtx());
    expect(out.kind).toBe('done');
    expect(out.result.successCount).toBe(2);
    expect(out.result.failedCount).toBe(0);

    const savedA = await db!.collection('assets').findOne({ _id: a._id } as never);
    const savedB = await db!.collection('assets').findOne({ _id: b._id } as never);
    expect(typeof (savedA as { cf_thumb_synced_at?: string })?.cf_thumb_synced_at).toBe('string');
    expect(typeof (savedB as { cf_thumb_synced_at?: string })?.cf_thumb_synced_at).toBe('string');
  });

  it('skips (does not fail) an asset whose thumbnail has not been generated yet', async () => {
    if (!mongoReachable) return;
    stubFetch(200);
    const pending = await makePendingAsset('nothumb.jpg', 'c'.repeat(32), { noThumb: true });

    const out = await cfThumbBackfillHandler.run({}, noopCtx());
    expect(out.kind).toBe('done');
    expect(out.result.successCount).toBe(0);
    expect(out.result.skippedCount).toBe(1);
    expect(out.result.failedCount).toBe(0);

    const saved = await db!.collection('assets').findOne({ _id: pending._id } as never);
    expect((saved as { cf_thumb_synced_at?: string })?.cf_thumb_synced_at).toBeNull();
  });

  it('records a failure (not a skip) when R2 rejects the upload, and leaves the asset pending', async () => {
    if (!mongoReachable) return;
    stubFetch(500);
    const failing = await makePendingAsset('fails.jpg', 'd'.repeat(32));

    const out = await cfThumbBackfillHandler.run({}, noopCtx());
    expect(out.kind).toBe('done');
    expect(out.result.successCount).toBe(0);
    expect(out.result.failedCount).toBe(1);
    expect(out.result.failures).toHaveLength(1);

    const saved = await db!.collection('assets').findOne({ _id: failing._id } as never);
    expect((saved as { cf_thumb_synced_at?: string })?.cf_thumb_synced_at).toBeNull();
  });

  it('stops early and returns cancelled when cancellation is requested mid-run', async () => {
    if (!mongoReachable) return;
    stubFetch(200);
    await makePendingAsset('e.jpg', 'e'.repeat(32));
    await makePendingAsset('f.jpg', 'f'.repeat(32));

    let calls = 0;
    const out = await cfThumbBackfillHandler.run(
      {},
      noopCtx({
        shouldCancel: async () => {
          calls += 1;
          return calls > 1; // let the first check through, cancel on the next
        },
      }),
    );
    expect(out.kind).toBe('cancelled');
  });

  it('reports done with zero counts when nothing is pending', async () => {
    if (!mongoReachable) return;
    const out = await cfThumbBackfillHandler.run({}, noopCtx());
    expect(out.kind).toBe('done');
    expect(out.result.successCount).toBe(0);
    expect(out.result.skippedCount).toBe(0);
    expect(out.result.failedCount).toBe(0);
  });
});
