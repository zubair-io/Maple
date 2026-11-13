/**
 * The folder-scan handler against a real directory: it walks every supported
 * file into the discover producer, skips the reserved trees, stamps
 * `last_scan` when it completes, and stops between directory batches when
 * cancelled. Relinking and `.mapleignore` are covered through the scan routes.
 *
 * The resume tests run the handler through `executeJob` on a real job row, one
 * directory level per batch, and stop an attempt part-way through a batch. A
 * file added afterwards to a directory tells whether the next attempt listed
 * that directory again.
 */

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { AttemptSuperseded } from '../../temporal/activity-attempt.ts';
import {
  recordedAttempt,
  type RecordedAttempt,
} from '../../temporal/recorded-attempt.test-helpers.ts';
import { executeJob } from '../execute-job.ts';
import { cancelUnfinishedJob, claimJob, createJob, getJob, requestCancel } from '../jobs.repo.ts';
import { folderScanHandler, folderScanHandlerSavingEvery } from './folder-scan.ts';
import type { JobHandler, JobHandlerContext } from './index.ts';

let live: LiveTestDatabase;
let root: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'folder-scan-'));
  invalidateLibraryRoots();
});

afterEach(async () => {
  setSystemTime();
  live.close();
  invalidateLibraryRoots();
  await rm(root, { recursive: true, force: true });
});

function context(cancelled = false, checkpoint?: Record<string, unknown>) {
  const progress: number[] = [];
  const ctx: JobHandlerContext = {
    jobId: new ObjectId(),
    checkpoint,
    reportProgress: async (current) => {
      progress.push(current);
    },
    shouldCancel: async () => cancelled,
  };
  return { ctx, progress };
}

const indexedPaths = () =>
  (
    live.db.query(`SELECT path, filename FROM asset_locations`).all() as {
      path: string;
      filename: string;
    }[]
  )
    .map((row) => join(row.path, row.filename))
    .toSorted();

const lastScan = (folderId: string) =>
  (
    live.db.query(`SELECT last_scan FROM folders WHERE id = ?`).get(folderId) as {
      last_scan: string | null;
    }
  ).last_scan;

/** Four directory levels with one photo each, so each batch of the walk lists exactly one level. */
async function seedNestedLibrary(): Promise<void> {
  await mkdir(join(root, 'year', 'month', 'day'), { recursive: true });
  await writeFile(join(root, 'top.jpg'), 'top bytes');
  await writeFile(join(root, 'year', 'year.jpg'), 'year bytes');
  await writeFile(join(root, 'year', 'month', 'month.jpg'), 'month bytes');
  await writeFile(join(root, 'year', 'month', 'day', 'day.jpg'), 'day bytes');
}

const inLibrary = (dir: unknown) => (typeof dir === 'string' ? join(root, dir) : dir);

type BatchHook = (batch: number, ctx: JobHandlerContext) => Promise<void> | void;

/**
 * `handler` with `atBatch` run as each batch starts. The walk asks whether it
 * is cancelled exactly once per batch, before listing, which is what counts them.
 */
function scanHandlers(
  atBatch: BatchHook = () => {},
  handler = folderScanHandlerSavingEvery(0),
): { folder_scan: JobHandler } {
  const seen = { batches: 0 };
  return {
    folder_scan: {
      run: (payload, ctx) =>
        handler.run(payload, {
          ...ctx,
          shouldCancel: async () => {
            const cancelled = await ctx.shouldCancel();
            seen.batches += 1;
            await atBatch(seen.batches, ctx);
            return cancelled;
          },
        }),
    },
  };
}

/**
 * Ends `attempt` the way a restart does, during the third batch: `year/month`
 * has been listed and its photo handed to discover, and the position that
 * says so was never saved. The row is left running under the dead attempt.
 */
async function interruptDuringThirdBatch(jobId: string, attempt: RecordedAttempt): Promise<void> {
  const handlers = scanHandlers((batch) => {
    if (batch === 3) attempt.stop = 'superseded';
  });
  await expect(executeJob(jobId, attempt, { handlers })).rejects.toBeInstanceOf(AttemptSuperseded);
}

async function queueScan(folderId: string) {
  return createJob({ kind: 'folder_scan', payload: { folderId } });
}

describe('folder_scan', () => {
  it('indexes supported files, skips the reserved trees, and stamps last_scan', async () => {
    await mkdir(join(root, 'trip', 'day1'), { recursive: true });
    await mkdir(join(root, '.maple'), { recursive: true });
    await mkdir(join(root, '_duplicates'), { recursive: true });
    await writeFile(join(root, 'trip', 'day1', 'a.jpg'), 'a bytes');
    await writeFile(join(root, 'trip', 'b.dng'), 'b bytes');
    await writeFile(join(root, 'trip', 'notes.txt'), 'not media');
    await writeFile(join(root, '.maple', 'c.jpg'), 'cache');
    await writeFile(join(root, '_duplicates', 'd.jpg'), 'copy');
    const folderId = insertFolder(live.db, { path: root, slug: 'scan' });
    const { ctx, progress } = context();

    const outcome = await folderScanHandler.run({ folderId }, ctx);

    expect(outcome.kind).toBe('done');
    expect(indexedPaths()).toEqual(['trip/b.dng', 'trip/day1/a.jpg']);
    expect(lastScan(folderId)).toBe(outcome.result['last_scan'] as string);
    expect(progress.at(-1)).toBe(2);
  });

  it('stops when cancelled and leaves last_scan alone', async () => {
    await writeFile(join(root, 'a.jpg'), 'a bytes');
    const folderId = insertFolder(live.db, { path: root, slug: 'cancelled' });

    const outcome = await folderScanHandler.run({ folderId }, context(true).ctx);

    expect(outcome).toEqual({ kind: 'cancelled', result: { last_scan: null } });
    expect(indexedPaths()).toEqual([]);
    expect(lastScan(folderId)).toBeNull();
  });

  it.each([
    { queue: 'year', found: 3 },
    { queue: [7], found: 3 },
    { queue: ['year'], found: -1 },
    { queue: ['year'], found: 1.5 },
    { queue: ['year'] },
  ])('walks from the root when the saved position is %j', async (saved) => {
    await seedNestedLibrary();
    const folderId = insertFolder(live.db, { path: root, slug: 'unreadable' });
    const queue = Array.isArray(saved.queue) ? saved.queue.map(inLibrary) : saved.queue;
    const { ctx, progress } = context(false, { ...saved, queue });

    const outcome = await folderScanHandler.run({ folderId }, ctx);

    expect(outcome.kind).toBe('done');
    expect(indexedPaths()).toHaveLength(4);
    expect(progress).toEqual([1, 2, 3, 4]);
  });

  it('fails for a folder that is no longer registered', async () => {
    const run = folderScanHandler.run({ folderId: new ObjectId().toHexString() }, context().ctx);

    await expect(run).rejects.toThrow('Folder not found');
  });
});

describe('folder_scan after an interruption', () => {
  it('lists only the outstanding directories, continues the count and stamps last_scan', async () => {
    await seedNestedLibrary();
    const folderId = insertFolder(live.db, { path: root, slug: 'resume' });
    const job = await queueScan(folderId);
    const jobId = job._id.toHexString();

    await interruptDuringThirdBatch(jobId, recordedAttempt('first'));

    const interrupted = (await getJob(job._id))!;
    expect(interrupted.status).toBe('running');
    expect(interrupted.checkpoint).toEqual({ queue: [join(root, 'year', 'month')], found: 2 });
    expect(indexedPaths()).toEqual(['top.jpg', 'year/month/month.jpg', 'year/year.jpg']);
    expect(lastScan(folderId)).toBeNull();

    await writeFile(join(root, 'late-top.jpg'), 'late top bytes');
    await writeFile(join(root, 'year', 'late-year.jpg'), 'late year bytes');
    await writeFile(join(root, 'year', 'month', 'late-month.jpg'), 'late month bytes');
    const second = recordedAttempt('second');

    const outcome = await executeJob(jobId, second, { handlers: scanHandlers() });

    expect(outcome).toEqual({ outcome: 'done' });
    expect(indexedPaths()).toEqual([
      'top.jpg',
      'year/month/day/day.jpg',
      'year/month/late-month.jpg',
      'year/month/month.jpg',
      'year/year.jpg',
    ]);
    expect(second.beats.map((beat) => beat.current)).toEqual([2, 2, 4, 4, 5]);
    const finished = (await getJob(job._id))!;
    expect(finished.status).toBe('done');
    expect(finished.progress.current).toBe(5);
    expect(lastScan(folderId)).toBe(finished.result!['last_scan'] as string);
  });

  it('cannot move the saved position once a later attempt holds the row', async () => {
    await seedNestedLibrary();
    const folderId = insertFolder(live.db, { path: root, slug: 'replaced' });
    const job = await queueScan(folderId);
    const handlers = scanHandlers(async (batch, ctx) => {
      if (batch === 3) await claimJob(ctx.jobId, 'second');
    });

    const outcome = await executeJob(job._id.toHexString(), recordedAttempt('first'), { handlers });

    expect(outcome).toEqual({
      outcome: 'failed',
      error: 'The job lease was claimed by another worker',
    });
    const held = (await getJob(job._id))!;
    expect(held.status).toBe('running');
    expect(held.locked_by).toBe('second');
    expect(held.checkpoint).toEqual({ queue: [join(root, 'year', 'month')], found: 2 });
  });

  it('starts a new scan from the root, whatever an earlier one had saved', async () => {
    await seedNestedLibrary();
    const folderId = insertFolder(live.db, { path: root, slug: 'fresh' });
    const abandoned = await queueScan(folderId);
    await interruptDuringThirdBatch(abandoned._id.toHexString(), recordedAttempt('first'));
    await cancelUnfinishedJob(abandoned._id);
    await writeFile(join(root, 'late-top.jpg'), 'late top bytes');
    const fresh = await queueScan(folderId);
    const attempt = recordedAttempt('fresh');

    const outcome = await executeJob(fresh._id.toHexString(), attempt, {
      handlers: scanHandlers(),
    });

    expect(outcome).toEqual({ outcome: 'done' });
    expect(fresh._id.equals(abandoned._id)).toBe(false);
    expect(indexedPaths()).toContain('late-top.jpg');
    expect(attempt.beats.map((beat) => beat.current)).toEqual([0, 0, 2, 2, 3, 3, 4, 4, 5]);
    expect(lastScan(folderId)).not.toBeNull();
  });

  it('is cancelled part-way, drops its saved position and leaves last_scan alone', async () => {
    await seedNestedLibrary();
    const folderId = insertFolder(live.db, { path: root, slug: 'cancel-part-way' });
    const job = await queueScan(folderId);
    const handlers = scanHandlers(async (batch, ctx) => {
      if (batch === 2) await requestCancel(ctx.jobId);
    });

    const outcome = await executeJob(job._id.toHexString(), recordedAttempt('only'), { handlers });

    expect(outcome).toEqual({ outcome: 'cancelled' });
    const cancelled = (await getJob(job._id))!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.result).toEqual({ last_scan: null });
    expect(cancelled.checkpoint).toEqual({});
    expect(indexedPaths()).toEqual(['top.jpg', 'year/year.jpg']);
    expect(lastScan(folderId)).toBeNull();
  });

  it('saves the position once its interval has passed, and not on the batches around it', async () => {
    await seedNestedLibrary();
    const folderId = insertFolder(live.db, { path: root, slug: 'interval' });
    const job = await queueScan(folderId);
    const handlers = scanHandlers((batch) => {
      if (batch === 2) setSystemTime(new Date(Date.now() + 60 * 60 * 1000));
    }, folderScanHandler);

    const outcome = await executeJob(job._id.toHexString(), recordedAttempt('only'), { handlers });

    expect(outcome).toEqual({ outcome: 'done' });
    const finished = (await getJob(job._id))!;
    expect(finished.progress.current).toBe(4);
    expect(finished.checkpoint).toEqual({ queue: [join(root, 'year', 'month')], found: 2 });
  });
});
