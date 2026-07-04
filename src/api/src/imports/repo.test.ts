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
  await db!.collection('import_files').deleteMany({});
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
    // Files live in the `import_files` collection now, not on the claim doc.
    expect(await repo.getImportFiles(claim!._id)).toHaveLength(2);

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
    const midFiles = await repo.getImportFiles(claim!._id);
    expect(midFiles[0].state).toBe('copied');
    expect(mid!.progress.current).toBe(1);
    expect(mid!.counts.copied).toBe(1);

    await repo.completeImport(claim!._id, { copied: 2, skipped: 0, failed: 0 });
    const done = await repo.getImport(claim!._id);
    expect(done!.status).toBe('done');
    expect(done!.locked_by).toBeNull();
    expect(done!.counts.copied).toBe(2);
  });

  it('stores files in the import_files collection, never inline on the import doc (#offset-overflow)', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');

    // A folder with many files used to serialize the whole `files[]` array into
    // one `imports` document, which a large folder pushed past MongoDB's 16 MiB
    // ceiling (a BSON `ERR_OUT_OF_RANGE` at the 17 MiB buffer boundary), failing
    // the import mid-scan. The entries must now live one-per-doc so no single
    // write grows with file count.
    const many = Array.from({ length: 2_000 }, (_, i) => file(`f${i}.dng`));
    const created = await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: many,
    });
    expect(created.progress.total).toBe(2_000);

    // The import doc carries NO inline files array.
    const rawDoc = await db!.collection('imports').findOne({ _id: created._id });
    expect(rawDoc!.files).toBeUndefined();

    // Every entry landed in import_files, retrievable in stable idx order.
    expect(await db!.collection('import_files').countDocuments({ import_id: created._id })).toBe(
      2_000,
    );
    const back = await repo.getImportFiles(created._id);
    expect(back).toHaveLength(2_000);
    expect(back[0].src).toBe('f0.dng');
    expect(back[1999].src).toBe('f1999.dng');
    expect(back.map((f) => f.idx)).toEqual(Array.from({ length: 2_000 }, (_, i) => i));
  });

  it('getImportFiles hydrates a legacy inline-files import into import_files on first read', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');

    // Simulate a pre-migration import: files inline on the doc, no import_files
    // rows. (Insert the legacy shape directly — createImport no longer writes
    // inline files.)
    const legacyId = new ObjectId();
    await db!.collection('imports').insertOne({
      _id: legacyId,
      status: 'failed',
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [file('legacy-a.dng'), file('legacy-b.dng')],
      scan_pending: false,
      progress: { current: 0, total: 2 },
      counts: { copied: 0, skipped: 0, failed: 0 },
      error: 'old failure',
      locked_by: null,
      lease_expires_at: null,
      cancel_requested: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    // First read returns the inline files AND migrates them into import_files.
    const back = await repo.getImportFiles(legacyId);
    expect(back.map((f) => f.src)).toEqual(['legacy-a.dng', 'legacy-b.dng']);
    expect(await db!.collection('import_files').countDocuments({ import_id: legacyId })).toBe(2);

    // After hydration, per-file progress writes land on real rows (no throw).
    await repo.updateImportProgress(
      legacyId,
      {
        index: 1,
        state: 'copied',
        error: null,
        destRel: '2024/03/legacy-b.dng',
        current: 1,
        counts: { copied: 1, skipped: 0, failed: 0 },
      },
      60_000,
    );
    expect((await repo.getImportFiles(legacyId))[1].state).toBe('copied');
  });

  it('updateImportProgress throws when the target file row is missing', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    const created = await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [file('a.dng')],
    });
    // idx 1 does not exist (only idx 0 was created) — fail loudly rather than
    // bumping import-level counts against per-file state that didn't move.
    await expect(
      repo.updateImportProgress(
        created._id,
        {
          index: 1,
          state: 'copied',
          error: null,
          destRel: '2024/03/missing.dng',
          current: 1,
          counts: { copied: 1, skipped: 0, failed: 0 },
        },
        60_000,
      ),
    ).rejects.toThrow(/no import_files row/);
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
    const requeuedFiles = await repo.getImportFiles(created._id);
    expect(requeuedFiles[0].state).toBe('copied');
    expect(requeuedFiles[1].state).toBe('pending');
    expect(requeuedFiles[1].error).toBeNull();

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
    expect((await repo.getImportFiles(created._id))[1].state).toBe('pending');
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
        // ... and one with a nested (>3-segment) dest. This is now a LEGITIMATE
        // shape (the misc/shot-folder defaults and a nearby-asset-match both
        // produce >3 segments — see dest.ts), so every segment being
        // individually safe means the whole dest is recoverable.
        {
          src: '/srv/in/nested.dng',
          dest: '2024/03/sub/nested.dng',
          size: 1,
          mtime: 0,
          kind: 'image',
          state: 'failed',
          error: 'transient',
        },
        // ... and one with a genuinely unsafe segment buried in a nested dest
        // (a leading-dot directory) — depth doesn't exempt it from validation.
        {
          src: '/srv/in/hidden.dng',
          dest: '2024/03/.hidden/hidden.dng',
          size: 1,
          mtime: 0,
          kind: 'image',
          state: 'failed',
          error: 'unsafe directory segment',
        },
      ],
    });
    await repo.failImport(created._id, 'four files failed');

    expect(await repo.retryImport(created._id)).toBe(true);
    const requeued = await repo.getImport(created._id);
    expect(requeued!.status).toBe('pending');
    // Recoverable ones are reset; the unsafe one stays failed and is still counted.
    const requeuedFiles = await repo.getImportFiles(created._id);
    expect(requeuedFiles[0].state).toBe('pending');
    expect(requeuedFiles[1].state).toBe('failed');
    // A >3-segment dest with every segment safe is now recoverable.
    expect(requeuedFiles[2].state).toBe('pending');
    // A leading-dot segment stays unsafe regardless of depth.
    expect(requeuedFiles[3].state).toBe('failed');
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
  });

  it('retryImport re-scans a fileless failed import (scan-level failure) (#800)', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');

    // A scan-level / auto-import failure: the deferred scan rejected an unsafe
    // temp name and bailed before writing any file rows. files: [], failed: 0.
    const fileless = await repo.createImport({
      source_root: '/srv/photos/Unsorted',
      library_id: lib.id,
      library_root: lib.root,
      files: [],
      scan_pending: true,
    });
    await repo.failImport(fileless._id, 'unsafe filename: ".LrTmp-abc.mp4"');

    // Retry re-queues it for a FRESH scan rather than no-opping.
    expect(await repo.retryImport(fileless._id)).toBe(true);

    const requeued = await repo.getImport(fileless._id);
    expect(requeued!.status).toBe('pending');
    expect(requeued!.scan_pending).toBe(true);
    expect(requeued!.error).toBeNull();
    expect(await repo.getImportFiles(fileless._id)).toEqual([]);
    expect(requeued!.locked_by).toBeNull();
    expect(requeued!.lease_expires_at).toBeNull();
    expect(requeued!.cancel_requested).toBe(false);

    // A worker re-claims it and the claim carries scan_pending so the worker
    // re-scans the source (rather than copying an empty file list).
    const claim = await repo.claimImport('w-rescan', 60_000);
    expect(claim).not.toBeNull();
    expect(claim!._id.equals(fileless._id)).toBe(true);
    expect(claim!.scan_pending).toBe(true);
  });

  it('retryImport refuses a failed import whose files are all permanently-unsafe (#800)', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');

    // A `failed` import that DID produce file rows, but none are recoverable
    // (backslash dest can never pass destRelPath). Re-scanning wouldn't help —
    // the names are still unsafe — so this stays 409, NOT re-scanned.
    const created = await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [
        {
          src: '/srv/in/bad.dng',
          dest: '2024/03/ba\\d.dng',
          size: 1,
          mtime: 0,
          kind: 'image',
          state: 'failed',
          error: 'unsafe filename',
        },
      ],
    });
    await repo.failImport(created._id, 'all files failed');
    expect(await repo.retryImport(created._id)).toBe(false);
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
