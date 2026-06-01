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

  it('retryImport re-queues a failed import: failed files → pending, copied stays (#795)', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');

    const created = await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [file('copied.dng'), file('bad.dng')],
    });
    // Simulate a partial run: one copied, one failed → import ends `failed`-ish.
    await repo.updateImportProgress(
      created._id,
      {
        index: 0,
        state: 'copied',
        error: null,
        destRel: '2024/03/copied.dng',
        current: 1,
        counts: { copied: 1, skipped: 0, failed: 0 },
      },
      60_000,
    );
    await repo.updateImportProgress(
      created._id,
      {
        index: 1,
        state: 'failed',
        error: 'unsafe filename',
        destRel: '2024/03/bad.dng',
        current: 2,
        counts: { copied: 1, skipped: 0, failed: 1 },
      },
      60_000,
    );
    await repo.failImport(created._id, 'a file failed');

    expect(await repo.retryImport(created._id)).toBe(true);

    const requeued = await repo.getImport(created._id);
    expect(requeued!.status).toBe('pending');
    expect(requeued!.error).toBeNull();
    expect(requeued!.counts.failed).toBe(0);
    expect(requeued!.locked_by).toBeNull();
    expect(requeued!.lease_expires_at).toBeNull();
    // The copied file is untouched; the failed one is reset to pending.
    expect(requeued!.files[0].state).toBe('copied');
    expect(requeued!.files[1].state).toBe('pending');
    expect(requeued!.files[1].error).toBeNull();

    // A worker can re-claim it.
    const claim = await repo.claimImport('w-retry', 60_000);
    expect(claim).not.toBeNull();
    expect(claim!._id.equals(created._id)).toBe(true);
  });

  it('retryImport re-queues a done-with-failures import (#795)', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    const created = await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [file('a.dng'), file('b.dng')],
    });
    await repo.updateImportProgress(
      created._id,
      {
        index: 1,
        state: 'failed',
        error: 'boom',
        destRel: '2024/03/b.dng',
        current: 2,
        counts: { copied: 1, skipped: 0, failed: 1 },
      },
      60_000,
    );
    await repo.completeImport(created._id, { copied: 1, skipped: 0, failed: 1 });

    expect(await repo.retryImport(created._id)).toBe(true);
    const requeued = await repo.getImport(created._id);
    expect(requeued!.status).toBe('pending');
    expect(requeued!.files[1].state).toBe('pending');
  });

  it('retryImport leaves a permanently-unsafe file failed and recounts (#795)', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    const created = await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [
        // A recoverable failed file (safe dest) ...
        {
          src: '/srv/in/ok.dng',
          dest: '2024/03/ok.dng',
          size: 1,
          mtime: 0,
          kind: 'image',
          state: 'failed',
          error: 'transient',
        },
        // ... and one whose dest can never pass destRelPath (backslash name).
        {
          src: '/srv/in/bad.dng',
          dest: '2024/03/ba\\d.dng',
          size: 1,
          mtime: 0,
          kind: 'image',
          state: 'failed',
          error: 'unsafe filename',
        },
        // ... and one with a nested (>3-segment) dest that violates the
        // `<year>/<label>/<filename>` invariant. Each segment is individually
        // "safe", but the extra path level is not — it must NOT be resurrected.
        {
          src: '/srv/in/nested.dng',
          dest: '2024/03/sub/nested.dng',
          size: 1,
          mtime: 0,
          kind: 'image',
          state: 'failed',
          error: 'unexpected nested dest',
        },
      ],
    });
    await repo.failImport(created._id, 'three files failed');

    expect(await repo.retryImport(created._id)).toBe(true);
    const requeued = await repo.getImport(created._id);
    expect(requeued!.status).toBe('pending');
    // Recoverable one is reset; the unsafe ones stay failed and are still counted.
    expect(requeued!.files[0].state).toBe('pending');
    expect(requeued!.files[1].state).toBe('failed');
    // A >3-segment dest is treated as unsafe — stays failed, not resurrected.
    expect(requeued!.files[2].state).toBe('failed');
    expect(requeued!.counts.failed).toBe(2);
  });

  it('retryImport refuses a clean done import and an unknown id (#795)', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    const created = await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [file('a.dng')],
    });
    await repo.completeImport(created._id, { copied: 1, skipped: 0, failed: 0 });
    // Clean done (no failures) → not retryable.
    expect(await repo.retryImport(created._id)).toBe(false);
    // Unknown id → false.
    expect(await repo.retryImport(new ObjectId())).toBe(false);

    // A `failed` import with NO files (empty-source auto-import failure) has
    // nothing to recover → not retryable, even though its status is failed.
    const empty = await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [],
    });
    await repo.failImport(empty._id, 'no importable files');
    expect(await repo.retryImport(empty._id)).toBe(false);
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
