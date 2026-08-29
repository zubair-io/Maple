/**
 * imports/retry.ts integration tests. Real Mongo (skip-pass when unreachable).
 *
 * Covers every branch of `retryImport`: per-file recovery (failed → pending,
 * copied left alone), the permanently-unsafe-dest hold-back, the fresh
 * re-scan for a scan-level failure, and the refusals (a clean `done`, an
 * unknown id, an import with nothing recoverable).
 *
 * Split from `repo.test.ts` with the function itself — see `retry.ts`.
 */

import { describe, it, expect } from 'bun:test';
import { ObjectId } from 'mongodb';
import { file, useImportsTestDb } from './imports-test-db.fixtures.ts';

const ctx = useImportsTestDb(`maple_test_imports_retry_${process.pid}`, 'imports.retry.test');
const lib = ctx.lib;

describe('imports.retry', () => {
  it('retryImport re-queues a failed import: failed files → pending, copied stays (#795)', async () => {
    if (!ctx.reachable) return;
    const repo = { ...(await import('./repo.ts')), ...(await import('./retry.ts')) };

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
    if (!ctx.reachable) return;
    const repo = { ...(await import('./repo.ts')), ...(await import('./retry.ts')) };
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
    if (!ctx.reachable) return;
    const repo = { ...(await import('./repo.ts')), ...(await import('./retry.ts')) };
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
    if (!ctx.reachable) return;
    const repo = { ...(await import('./repo.ts')), ...(await import('./retry.ts')) };
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
    if (!ctx.reachable) return;
    const repo = { ...(await import('./repo.ts')), ...(await import('./retry.ts')) };

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
    if (!ctx.reachable) return;
    const repo = { ...(await import('./repo.ts')), ...(await import('./retry.ts')) };

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
});
