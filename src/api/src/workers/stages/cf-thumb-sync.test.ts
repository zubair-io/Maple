/**
 * cf-thumb-sync stage handler tests. Real Mongo + real tmp filesystem
 * (skip-pass when Mongo is unreachable, mirroring every other DB-backed
 * suite in this repo). `fetch` is stubbed globally rather than mocking
 * `r2-client.ts`, same technique used throughout `src/cloudflare/`.
 */

import { describe, expect, it, beforeAll, afterAll, afterEach, beforeEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import cfThumbSyncStage from './cf-thumb-sync.ts';

const TEST_DB = `maple_test_cf_thumb_sync_${process.pid}`;
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

const CF_CONFIG = {
  enabled: true,
  account_id: 'acct123',
  bucket: 'maple-thumbs',
  access_key_id: 'AKIAEXAMPLE',
  secret_access_key: 'secretexample',
};

describe('cf-thumb-sync stage', () => {
  let mongo: MongoClient | null = null;
  let mongoReachable = false;
  let db: Db | null = null;
  let dir: string;
  let libId: ObjectId;
  const realFetch = globalThis.fetch;

  function stubFetch(status: number): void {
    globalThis.fetch = (async () => new Response('', { status })) as unknown as typeof fetch;
  }

  async function makeAsset(
    filename: string,
    mapleId: string,
    opts?: { noThumb?: boolean; hidden?: boolean },
  ) {
    const relDir = 'vacation';
    if (!opts?.noThumb) {
      const thumbDir = path.join(dir, relDir, '.maple', 'thumbs');
      await mkdir(thumbDir, { recursive: true });
      await writeFile(path.join(thumbDir, `${mapleId}.jpg`), Buffer.from('fake-jpeg-bytes'));
    }
    return {
      _id: new ObjectId(),
      fileinfo: [{ path: relDir, filename, library_id: libId, deleted_at: null }],
      maple_id: mapleId,
      hidden: opts?.hidden ?? false,
      cf_thumb_synced_at: null as string | null,
    };
  }

  beforeAll(async () => {
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) {
      console.log('[cf-thumb-sync.test] skipping: MongoDB unreachable');
      return;
    }
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    const { closeDb } = await import('../../db/client.ts');
    await closeDb();
    dir = await mkdtemp(path.join(os.tmpdir(), 'cf-thumb-sync-'));
    const { foldersCollection } = await import('../../db/client.ts');
    const { invalidateLibraryRoots } = await import('../../indexer/libraries.cache.ts');
    libId = new ObjectId();
    const folders = await foldersCollection();
    await folders.insertOne({
      _id: libId,
      slug: 'cf-thumb-sync-lib',
      path: dir,
      label: 'cf-thumb-sync-lib',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    invalidateLibraryRoots();
  });

  beforeEach(async () => {
    if (!mongoReachable) return;
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

  it('uploads the thumbnail and returns a patch stamping cf_thumb_synced_at', async () => {
    if (!mongoReachable) return;
    stubFetch(200);
    const asset = await makeAsset('a.jpg', 'a'.repeat(32));

    const result = await cfThumbSyncStage.handler(asset as never, {} as never);
    expect(result).toHaveProperty('patch');
    const patch = (result as { patch: { cf_thumb_synced_at: string } }).patch;
    expect(typeof patch.cf_thumb_synced_at).toBe('string');
  });

  it('skips a hidden asset without touching R2', async () => {
    if (!mongoReachable) return;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const asset = await makeAsset('hidden.jpg', 'h'.repeat(32), { hidden: true });

    const result = await cfThumbSyncStage.handler(asset as never, {} as never);
    expect(result).toEqual({ skip: 'hidden' });
    expect(fetchCalled).toBe(false);
  });

  it('cleans up R2 if a hidden asset is marked as synced', async () => {
    if (!mongoReachable) return;
    let fetchCalled = false;
    let fetchMethod = '';
    globalThis.fetch = (async (input, init) => {
      fetchCalled = true;
      fetchMethod = input instanceof Request ? input.method : (init?.method ?? 'GET');
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const asset = await makeAsset('hidden-synced.jpg', 's'.repeat(32), { hidden: true });
    asset.cf_thumb_synced_at = '2026-01-01T00:00:00.000Z';

    const result = await cfThumbSyncStage.handler(asset as never, {} as never);
    expect(result).toEqual({ skip: 'hidden' });
    expect(fetchCalled).toBe(true);
    expect(fetchMethod).toBe('DELETE');
  });

  it('skips terminally (no-thumb) when the thumbnail has not been generated yet', async () => {
    if (!mongoReachable) return;
    stubFetch(200);
    const asset = await makeAsset('nothumb.jpg', 'b'.repeat(32), { noThumb: true });

    const result = await cfThumbSyncStage.handler(asset as never, {} as never);
    expect(result).toEqual({ skip: 'no-thumb' });
  });

  it('throws when Cloudflare config is not complete/enabled, for run-stage.ts to retry/dead-letter', async () => {
    if (!mongoReachable) return;
    await db!.collection('app_settings').deleteMany({});
    stubFetch(200);
    const asset = await makeAsset('c.jpg', 'c'.repeat(32));

    await expect(cfThumbSyncStage.handler(asset as never, {} as never)).rejects.toThrow(
      /not complete\/enabled/,
    );
  });

  it('propagates an R2 upload failure by throwing (retry/backoff owned by run-stage.ts)', async () => {
    if (!mongoReachable) return;
    stubFetch(500);
    const asset = await makeAsset('d.jpg', 'd'.repeat(32));

    await expect(cfThumbSyncStage.handler(asset as never, {} as never)).rejects.toThrow(/500/);
  });
});
