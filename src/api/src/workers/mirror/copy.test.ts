/**
 * mirror copy worker + queue repo tests. Integration tests against a real
 * Mongo (skip-pass when unreachable, mirroring trash-gc.test.ts). Covers the
 * durability boundary: enqueue idempotency, claim → copy → complete, idempotent
 * skip when the mirror is already current, drop-on-primary-gone, and
 * dead-letter after max attempts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTestDb } from '../../db/test-db.test-helpers.ts';

const TEST_DB = withTestDb(`maple_test_mirrorcopy_${process.pid}`);
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmp: string;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[mirror copy.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  // Pin the app's getDb() singleton to OUR test DB. Multiple Mongo test files
  // share one bun process, so the module-top env assignment can be overwritten
  // by another file's; re-set it here, right before closeDb() forces a
  // reconnect, so the worker reads the same DB the fixtures are written to.
  // We only need the mirror_queue unique index — not the full app
  // ensureIndexes() suite, which runs migrations unrelated to this worker.
  process.env.MAPLE_MONGO_DB = TEST_DB;
  const { closeDb, mirrorQueueCollection } = await import('../../db/client.ts');
  await closeDb();
  await (
    await mirrorQueueCollection()
  ).createIndex({ mirror_path: 1 }, { unique: true, name: 'mirror_queue_path' });
});

beforeEach(async () => {
  if (!mongoReachable || !db) return;
  await db.collection('mirror_queue').deleteMany({});
  tmp = mkdtempSync(join(tmpdir(), 'mirror-copy-test-'));
});

afterAll(async () => {
  if (mongo) await mongo.close();
});

describe('mirror copy worker', () => {
  it('enqueue is idempotent on mirror_path', async () => {
    if (!mongoReachable) return;
    const { enqueueMirrorCopy, mirrorQueueCounts } = await import('../../fs/mirror-queue.repo.ts');
    await enqueueMirrorCopy('/p/a.dng', '/m/a.dng', 'scan-missing');
    await enqueueMirrorCopy('/p/a.dng', '/m/a.dng', 'write-failure');
    expect((await mirrorQueueCounts()).pending).toBe(1);
  });

  it('claims, copies, and completes a pending row', async () => {
    if (!mongoReachable) return;
    const { enqueueMirrorCopy, mirrorQueueCounts } = await import('../../fs/mirror-queue.repo.ts');
    const { runMirrorCopyOnce } = await import('./copy.ts');
    const src = join(tmp, 'a.dng');
    const dst = join(tmp, 'mirror', 'a.dng');
    writeFileSync(src, 'raw-bytes');
    await enqueueMirrorCopy(src, dst, 'scan-missing');

    const summary = await runMirrorCopyOnce({ batchSize: 10 });
    expect(summary.copied).toBe(1);
    expect(readFileSync(dst, 'utf8')).toBe('raw-bytes');
    expect((await mirrorQueueCounts()).pending).toBe(0);
  });

  it('skips (and completes) when the mirror is already up to date', async () => {
    if (!mongoReachable) return;
    const { enqueueMirrorCopy } = await import('../../fs/mirror-queue.repo.ts');
    const { runMirrorCopyOnce } = await import('./copy.ts');
    const { copyFileToMirror } = await import('./replicate.ts');
    const src = join(tmp, 'a.dng');
    const dst = join(tmp, 'mirror', 'a.dng');
    writeFileSync(src, 'bytes');
    await copyFileToMirror(src, dst); // mirror already current (mtime preserved)
    await enqueueMirrorCopy(src, dst, 'scan-missing');

    const summary = await runMirrorCopyOnce({ batchSize: 10 });
    expect(summary.copied).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('drops the task when the primary file is gone', async () => {
    if (!mongoReachable) return;
    const { enqueueMirrorCopy, mirrorQueueCounts } = await import('../../fs/mirror-queue.repo.ts');
    const { runMirrorCopyOnce } = await import('./copy.ts');
    await enqueueMirrorCopy(
      join(tmp, 'missing.dng'),
      join(tmp, 'm', 'missing.dng'),
      'scan-missing',
    );
    const summary = await runMirrorCopyOnce({ batchSize: 10 });
    expect(summary.skipped).toBe(1);
    expect((await mirrorQueueCounts()).pending).toBe(0);
  });

  it('dead-letters after max attempts on a persistent failure', async () => {
    if (!mongoReachable) return;
    const { enqueueMirrorCopy, mirrorQueueCounts } = await import('../../fs/mirror-queue.repo.ts');
    const { runMirrorCopyOnce } = await import('./copy.ts');
    const src = join(tmp, 'a.dng');
    writeFileSync(src, 'bytes');
    // Make the mirror parent a FILE so mkdir(dirname(dst)) fails with ENOTDIR.
    const blocker = join(tmp, 'blocker');
    writeFileSync(blocker, 'i am a file');
    const dst = join(blocker, 'a.dng');
    await enqueueMirrorCopy(src, dst, 'scan-missing');

    const summary = await runMirrorCopyOnce({ batchSize: 10, maxAttempts: 1 });
    expect(summary.failed).toBe(1);
    const counts = await mirrorQueueCounts();
    expect(counts.dead).toBe(1);
    expect(counts.pending).toBe(0); // dead rows aren't claimable
  });
});
