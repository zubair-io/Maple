/**
 * imports/repo.ts integration tests. Real Mongo (skip-pass when unreachable).
 *
 * Covers: create → claim → progress → complete round-trip, double-claim
 * collision, lease-expiry reclaim, cancel flag, and content dedup against
 * the assets collection (by maple_id and by sha1_head).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import type { ImportFileEntry } from '../db/schema.ts';

const TEST_DB = `maple_test_imports_repo_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

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
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

function file(src: string): ImportFileEntry {
  return {
    src,
    dest: `2024/03/${src}`,
    size: 1,
    mtime: 0,
    kind: 'image',
    state: 'pending',
    error: null,
  };
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[imports.repo.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('imports').deleteMany({});
  await db!.collection('assets').deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {}
    try {
      await mongo.close();
    } catch {}
  }
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

const lib = { id: new ObjectId(), root: '/srv/lib' };

describe('imports.repo', () => {
  it('create → claim → progress → complete', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');

    const created = await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [file('a.dng'), file('b.dng')],
    });
    expect(created.status).toBe('pending');
    expect(created.progress).toEqual({ current: 0, total: 2 });

    const claim = await repo.claimImport('w-1', 60_000);
    expect(claim).not.toBeNull();
    expect(claim!.library_root).toBe('/srv/lib');
    expect(claim!.files).toHaveLength(2);

    const running = await repo.getImport(claim!._id);
    expect(running!.status).toBe('running');
    expect(running!.locked_by).toBe('w-1');

    await repo.updateImportProgress(
      claim!._id,
      {
        index: 0,
        state: 'copied',
        error: null,
        destRel: '2024/03/a.dng',
        current: 1,
        counts: { copied: 1, skipped: 0, failed: 0 },
      },
      60_000,
    );
    const mid = await repo.getImport(claim!._id);
    expect(mid!.files[0].state).toBe('copied');
    expect(mid!.progress.current).toBe(1);
    expect(mid!.counts.copied).toBe(1);

    await repo.completeImport(claim!._id, { copied: 2, skipped: 0, failed: 0 });
    const done = await repo.getImport(claim!._id);
    expect(done!.status).toBe('done');
    expect(done!.locked_by).toBeNull();
    expect(done!.counts.copied).toBe(2);
  });

  it('double-claim collision: only one of two concurrent claims wins', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [file('a.dng')],
    });
    const [a, b] = await Promise.all([
      repo.claimImport('A', 60_000),
      repo.claimImport('B', 60_000),
    ]);
    expect([a, b].filter((c) => c !== null)).toHaveLength(1);
  });

  it('lease expiry: a stale lock is reclaimable', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [file('a.dng')],
    });
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const c1 = await repo.claimImport('dead', 10, () => t0);
    expect(c1).not.toBeNull();
    const t1 = new Date('2026-01-01T00:00:01.000Z');
    const c2 = await repo.claimImport('alive', 60_000, () => t1);
    expect(c2).not.toBeNull();
    expect(c2!._id.equals(c1!._id)).toBe(true);
  });

  it('cancel flag: request flips it, isCancelRequested observes it', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    const created = await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [file('a.dng')],
    });
    expect(await repo.isImportCancelRequested(created._id)).toBe(false);
    expect(await repo.requestImportCancel(created._id)).toBe(true);
    expect(await repo.isImportCancelRequested(created._id)).toBe(true);
  });

  it('requestImportCancel returns false once the import is finished', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    const created = await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [file('a.dng')],
    });
    await repo.completeImport(created._id, { copied: 1, skipped: 0, failed: 0 });
    expect(await repo.requestImportCancel(created._id)).toBe(false);
  });

  it('assetExistsForHash matches by maple_id and by sha1_head', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    await db!.collection('assets').insertOne({ maple_id: 'mid-1', sha1_head: 'sha-1' });

    expect(await repo.assetExistsForHash('mid-1', 'other')).toBe(true);
    expect(await repo.assetExistsForHash('other', 'sha-1')).toBe(true);
    expect(await repo.assetExistsForHash('none', 'none')).toBe(false);
  });
});
