/**
 * hidden-cleanup integration tests. Real Mongo (skip-pass when unreachable,
 * same convention as the rest of this module's tests), `fetch` stubbed for
 * the R2 call — see `r2-client.test.ts`'s header comment for why.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { cleanupR2ThumbForHiddenAsset, cleanupR2ThumbsForHiddenAssets } from './hidden-cleanup.ts';

const TEST_DB = `maple_test_hidden_cleanup_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let libId: ObjectId;

const CF_CONFIG = {
  enabled: true,
  account_id: 'acct123',
  bucket: 'maple-thumbs',
  access_key_id: 'AKIAEXAMPLE',
  secret_access_key: 'secretexample',
};

const realFetch = globalThis.fetch;
let calls: Array<{ method: string; url: string }>;

function stubFetch(status: number): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ method, url });
    return new Response('', { status });
  }) as typeof fetch;
}

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

function makeAsset(overrides: Partial<{ synced: boolean; noFileinfo: boolean }> = {}) {
  return {
    _id: new ObjectId(),
    fileinfo: overrides.noFileinfo
      ? []
      : [{ path: 'vacation', filename: 'a.jpg', library_id: libId, deleted_at: null }],
    cf_thumb_synced_at: overrides.synced === false ? null : '2026-01-01T00:00:00.000Z',
  };
}

describe('cleanupR2ThumbForHiddenAsset / cleanupR2ThumbsForHiddenAssets', () => {
  beforeAll(async () => {
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) {
      console.log('[hidden-cleanup.test] skipping: MongoDB unreachable');
      return;
    }
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    const { closeDb } = await import('../db/client.ts');
    await closeDb();
    const { foldersCollection } = await import('../db/client.ts');
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    libId = new ObjectId();
    const folders = await foldersCollection();
    await folders.insertOne({
      _id: libId,
      slug: 'hidden-cleanup-lib',
      path: '/tmp/hidden-cleanup-lib',
      label: 'hidden-cleanup-lib',
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
      const { closeDb } = await import('../db/client.ts');
      await closeDb();
      try {
        await mongo!.db(TEST_DB).dropDatabase();
      } catch {}
      try {
        await mongo!.close();
      } catch {}
    }
  });

  it('deletes the R2 object and clears cf_thumb_synced_at for a previously-synced asset', async () => {
    if (!mongoReachable) return;
    stubFetch(200);
    const asset = makeAsset();
    await db!.collection('assets').insertOne(asset as never);

    await cleanupR2ThumbForHiddenAsset(asset);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('thumbs/hidden-cleanup-lib/vacation/a.jpg');

    const saved = await db!.collection('assets').findOne({ _id: asset._id } as never);
    expect((saved as { cf_thumb_synced_at?: string | null })?.cf_thumb_synced_at).toBeNull();
  });

  it('still attempts the R2 delete when the in-memory snapshot says never-synced (stale-read guard)', async () => {
    if (!mongoReachable) return;
    // A 404 is exactly what R2 would return for a genuinely-never-uploaded
    // key — deleteThumbFromR2 treats that as success. This exercises the
    // fix for the race where `asset.cf_thumb_synced_at` reflects a stale
    // pre-upload snapshot even though the real document (or R2 itself) has
    // since moved on; skipping on that stale read would leak a thumbnail
    // that actually did get uploaded moments after this asset was claimed.
    stubFetch(404);
    const asset = makeAsset({ synced: false });
    await db!.collection('assets').insertOne(asset as never);

    await cleanupR2ThumbForHiddenAsset(asset);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('DELETE');
    const saved = await db!.collection('assets').findOne({ _id: asset._id } as never);
    expect((saved as { cf_thumb_synced_at?: string | null })?.cf_thumb_synced_at).toBeNull();
  });

  it('is a no-op when Cloudflare credentials are not saved, even with enabled: true stale in memory', async () => {
    if (!mongoReachable) return;
    await db!.collection('app_settings').deleteMany({});
    stubFetch(200);
    const asset = makeAsset();
    await db!.collection('assets').insertOne(asset as never);

    await cleanupR2ThumbForHiddenAsset(asset);

    expect(calls).toHaveLength(0);
    const saved = await db!.collection('assets').findOne({ _id: asset._id } as never);
    expect((saved as { cf_thumb_synced_at?: string | null })?.cf_thumb_synced_at).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('runs even when Cloudflare uploads are currently disabled (enabled: false) — deletion is not gated on the toggle', async () => {
    if (!mongoReachable) return;
    await db!.collection('app_settings').updateOne({ _id: 'cloudflare' } as never, {
      $set: { config: { ...CF_CONFIG, enabled: false } },
    });
    stubFetch(200);
    const asset = makeAsset();
    await db!.collection('assets').insertOne(asset as never);

    await cleanupR2ThumbForHiddenAsset(asset);

    expect(calls).toHaveLength(1);
  });

  it('never throws when the R2 delete fails, and leaves cf_thumb_synced_at untouched', async () => {
    if (!mongoReachable) return;
    stubFetch(500);
    const asset = makeAsset();
    await db!.collection('assets').insertOne(asset as never);

    await expect(cleanupR2ThumbForHiddenAsset(asset)).resolves.toBeUndefined();

    const saved = await db!.collection('assets').findOne({ _id: asset._id } as never);
    expect((saved as { cf_thumb_synced_at?: string | null })?.cf_thumb_synced_at).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('skips an asset with no resolvable fileinfo without throwing', async () => {
    if (!mongoReachable) return;
    stubFetch(200);
    const asset = makeAsset({ noFileinfo: true });
    await db!.collection('assets').insertOne(asset as never);

    await cleanupR2ThumbForHiddenAsset(asset);

    expect(calls).toHaveLength(0);
  });

  it('bulk variant fans out deletes for every eligible asset in one credential resolve', async () => {
    if (!mongoReachable) return;
    stubFetch(200);
    const a = makeAsset();
    const b = makeAsset();
    // Attempted unconditionally too (see the stale-read test above) —
    // still counts toward the fan-out even though never actually synced.
    const notSynced = makeAsset({ synced: false });
    await db!.collection('assets').insertMany([a, b, notSynced] as never[]);

    await cleanupR2ThumbsForHiddenAssets([a, b, notSynced]);

    expect(calls).toHaveLength(3);
    const savedA = await db!.collection('assets').findOne({ _id: a._id } as never);
    const savedB = await db!.collection('assets').findOne({ _id: b._id } as never);
    const savedNotSynced = await db!.collection('assets').findOne({ _id: notSynced._id } as never);
    expect((savedA as { cf_thumb_synced_at?: string | null })?.cf_thumb_synced_at).toBeNull();
    expect((savedB as { cf_thumb_synced_at?: string | null })?.cf_thumb_synced_at).toBeNull();
    expect(
      (savedNotSynced as { cf_thumb_synced_at?: string | null })?.cf_thumb_synced_at,
    ).toBeNull();
  });

  it('bulk variant is a no-op for an empty list', async () => {
    if (!mongoReachable) return;
    stubFetch(200);
    await cleanupR2ThumbsForHiddenAssets([]);
    expect(calls).toHaveLength(0);
  });
});
