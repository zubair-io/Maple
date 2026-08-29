/**
 * imports/repo.ts integration tests. Real Mongo (skip-pass when unreachable).
 *
 * Covers: create → claim → progress → complete round-trip, double-claim
 * collision, lease-expiry reclaim, cancel flag, and content dedup against
 * the assets collection (by maple_id and by sha1_head).
 */

import { describe, it, expect } from 'bun:test';
import { ObjectId } from 'mongodb';
import { file, useImportsTestDb } from './imports-test-db.fixtures.ts';

const ctx = useImportsTestDb(`maple_test_imports_repo_${process.pid}`, 'imports.repo.test');
const lib = ctx.lib;

describe('imports.repo', () => {
  // Runs with or without Mongo, deliberately: the harness must point the
  // code under test at the scratch database, or the repo functions write to
  // the default one while these assertions read the scratch one and every
  // case below fails only on a machine that HAS Mongo.
  it('points the code under test at the scratch database', () => {
    expect(process.env.MAPLE_MONGO_DB).toBe(ctx.dbName);
  });

  it('create → claim → progress → complete', async () => {
    if (!ctx.reachable) return;
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
    if (!ctx.reachable) return;
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
    const rawDoc = await ctx.db.collection('imports').findOne({ _id: created._id });
    expect(rawDoc!.files).toBeUndefined();

    // Every entry landed in import_files, retrievable in stable idx order.
    expect(await ctx.db.collection('import_files').countDocuments({ import_id: created._id })).toBe(
      2_000,
    );
    const back = await repo.getImportFiles(created._id);
    expect(back).toHaveLength(2_000);
    expect(back[0].src).toBe('f0.dng');
    expect(back[1999].src).toBe('f1999.dng');
    expect(back.map((f) => f.idx)).toEqual(Array.from({ length: 2_000 }, (_, i) => i));
  });

  it('setImportFiles resets the per-file counter along with the file rows', async () => {
    if (!ctx.reachable) return;
    const repo = await import('./repo.ts');

    // A first attempt that got part-way through a big folder.
    const created = await repo.createImport({
      source_root: '/srv/in',
      library_id: lib.id,
      library_root: lib.root,
      files: [file('a.dng'), file('b.dng'), file('c.dng')],
    });
    await repo.updateImportProgress(
      created._id,
      {
        index: 0,
        state: 'copied',
        error: null,
        destRel: '2026/01/a.dng',
        current: 2,
        counts: { copied: 2, skipped: 0, failed: 0 },
      },
      60_000,
    );

    // The retry re-scans and finds fewer files. `current` must come back to 0
    // with the new file rows: left at 2 against a total of 1, the UI would
    // render a 200% completion rate for work this run has not done.
    await repo.setImportFiles(created._id, [file('only.dng')], 60_000);

    const doc = await ctx.db.collection('imports').findOne({ _id: created._id });
    expect(doc!.progress).toEqual({ current: 0, total: 1 });
  });

  it('getImportFiles hydrates a legacy inline-files import into import_files on first read', async () => {
    if (!ctx.reachable) return;
    const repo = await import('./repo.ts');

    // Simulate a pre-migration import: files inline on the doc, no import_files
    // rows. (Insert the legacy shape directly — createImport no longer writes
    // inline files.)
    const legacyId = new ObjectId();
    await ctx.db.collection('imports').insertOne({
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
    expect(await ctx.db.collection('import_files').countDocuments({ import_id: legacyId })).toBe(2);

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
    if (!ctx.reachable) return;
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
    if (!ctx.reachable) return;
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
    if (!ctx.reachable) return;
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
    if (!ctx.reachable) return;
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
    if (!ctx.reachable) return;
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
    if (!ctx.reachable) return;
    const repo = await import('./repo.ts');
    await ctx.db.collection('assets').insertOne({ maple_id: 'mid-1', sha1_head: 'sha-1' });

    expect(await repo.assetExistsForHash('mid-1', 'other')).toBe(true);
    expect(await repo.assetExistsForHash('other', 'sha-1')).toBe(true);
    expect(await repo.assetExistsForHash('none', 'none')).toBe(false);
  });
});
