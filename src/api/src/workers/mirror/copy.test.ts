/**
 * mirror copy worker tests. Real SQLite (one in-memory database per test,
 * installed process-wide so the worker's own queue calls reach it) and a real
 * temp filesystem. Covers the durability boundary: claim → copy → complete, the
 * idempotent skip when the mirror is already current, drop-on-primary-gone, and
 * dead-letter after max attempts.
 *
 * The queue's own properties — coalescing a re-detection onto an existing row,
 * the claim lease, the dead-letter arithmetic — belong to
 * `db/repos/mirror-queue.repo.test.ts` and are not repeated here. What
 * this file owns is what the worker does between claiming a row and completing
 * it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { enqueueMirrorCopy, mirrorQueueCounts } from '../../fs/mirror-queue.repo.ts';
import { drainMirrorCopyQueue, runMirrorCopyOnce } from './copy.ts';
import { copyFileToMirror } from './replicate.ts';

let live: LiveTestDatabase;
let tmp: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  tmp = mkdtempSync(join(tmpdir(), 'mirror-copy-test-'));
});

afterEach(() => {
  live.close();
});

describe('mirror copy worker', () => {
  it('claims, copies, and completes a pending row', async () => {
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

  it('claims nothing once the run is stopped', async () => {
    const src = join(tmp, 'a.dng');
    writeFileSync(src, 'bytes');
    await enqueueMirrorCopy(src, join(tmp, 'mirror', 'a.dng'), 'scan-missing');

    const summary = await runMirrorCopyOnce({ signal: AbortSignal.abort() });

    expect(summary.claimed).toBe(0);
    expect((await mirrorQueueCounts()).pending).toBe(1);
  });
});

describe('a scheduled drain', () => {
  const enqueueFiles = async (count: number, mirrorDir: string) => {
    for (let i = 0; i < count; i++) {
      const src = join(tmp, `f${i}.dng`);
      writeFileSync(src, `bytes-${i}`);
      await enqueueMirrorCopy(src, join(mirrorDir, `f${i}.dng`), 'scan-missing');
    }
  };

  it('empties a backlog larger than one batch in one run', async () => {
    await enqueueFiles(120, join(tmp, 'mirror'));

    await drainMirrorCopyQueue();

    expect(await mirrorQueueCounts()).toEqual({ pending: 0, dead: 0 });
  });

  it('stops after a batch with a failure, so an unreachable mirror keeps its retries', async () => {
    const blocker = join(tmp, 'blocker');
    writeFileSync(blocker, 'i am a file');
    await enqueueFiles(120, blocker);

    await drainMirrorCopyQueue();

    const attempts = live.db.query(`SELECT SUM(attempts) AS n FROM mirror_queue`).get() as {
      n: number;
    };
    expect(attempts.n).toBeLessThanOrEqual(50);
  });
});
