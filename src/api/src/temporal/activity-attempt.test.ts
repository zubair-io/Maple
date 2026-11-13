import { describe, expect, test } from 'bun:test';
import { MockActivityEnvironment } from '@temporalio/testing';
import { attemptStop, runAttempt } from './activity-attempt.ts';
import { ObjectId } from '../db/object-id.ts';
import {
  claimImport,
  createImport,
  getImport,
  ImportTakenOver,
  updateImportProgress,
} from '../db/repos/imports.repo.ts';
import { claimJob, createJob, getJob, updateProgress } from '../db/repos/jobs.repo.ts';
import {
  createTestDatabase,
  insertFolder,
  testSqliteDb,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

const details = (reason: Partial<NonNullable<Parameters<typeof attemptStop>[0]>>) => ({
  notFound: false,
  cancelRequested: false,
  paused: false,
  timedOut: false,
  workerShutdown: false,
  reset: false,
  ...reason,
});

describe('attemptStop', () => {
  test('nothing asked for, nothing to do', () => {
    expect(attemptStop(undefined)).toBeNull();
  });

  test.each(['workerShutdown', 'timedOut', 'notFound'] as const)(
    '%s leaves the handler running',
    (reason) => {
      expect(attemptStop(details({ [reason]: true }))).toBeNull();
    },
  );

  test('a cancel made in Temporal cancels the job', () => {
    expect(attemptStop(details({ cancelRequested: true }))).toBe('cancel');
    expect(attemptStop(details({ cancelRequested: true, workerShutdown: true }))).toBe('cancel');
  });

  test.each(['paused', 'reset'] as const)('%s stops the attempt for a later one', (reason) => {
    expect(attemptStop(details({ [reason]: true }))).toBe('superseded');
  });
});

/** What Temporal sends again after an activity reset: the same run, activity and attempt number. */
const REPEATED_DELIVERY = {
  workflowExecution: { workflowId: 'job-1', runId: 'run-1' },
  activityId: '7',
  attempt: 1,
};

const deliveredIdentity = (): Promise<string> =>
  new MockActivityEnvironment(REPEATED_DELIVERY).run(async () => {
    const delivered = Promise.withResolvers<string>();
    await runAttempt(async (attempt) => {
      delivered.resolve(attempt.identity);
      return { outcome: 'done' };
    });
    return delivered.promise;
  });

describe('two deliveries with the same run, activity and attempt number', () => {
  test('carry different identities that still name the run, activity and attempt', async () => {
    const first = await deliveredIdentity();
    const second = await deliveredIdentity();

    expect(first).not.toBe(second);
    expect(first).toStartWith('temporal:run-1:7:1:');
    expect(second).toStartWith('temporal:run-1:7:1:');
  });

  test('the first is refused its next job write once the second has claimed the job', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await createJob(
      { kind: 'batch_jpeg_export', payload: { assetIds: [], outputDir: '/tmp', quality: 80 } },
      undefined,
      undefined,
      db,
    );
    const first = await deliveredIdentity();
    const second = await deliveredIdentity();
    await claimJob(job._id, first, undefined, db);
    await claimJob(job._id, second, undefined, db);

    await expect(
      updateProgress(job._id, { current: 1, total: 2 }, undefined, first, db),
    ).rejects.toThrow('claimed by another worker');
    expect((await getJob(job._id, db))!.progress).toEqual({ current: 0, total: 0 });

    await updateProgress(job._id, { current: 1, total: 2 }, undefined, second, db);
    expect((await getJob(job._id, db))!.progress).toEqual({ current: 1, total: 2 });
  });

  test('the first is refused its next import write once the second has claimed the import', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const created = await createImport(
      {
        source_root: '/inbox',
        library_id: new ObjectId(insertFolder(handle.db)),
        library_root: '/libraries/main',
        files: [
          {
            src: '/inbox/A.dng',
            dest: '2026/04/A.dng',
            size: 4096,
            mtime: 1_700_000_000_000,
            kind: 'image',
            state: 'pending',
            error: null,
          },
        ],
      },
      undefined,
      db,
    );
    const copied = (holder: string) => ({
      index: 0,
      state: 'copied' as const,
      error: null,
      destRel: '2026/04/A.dng',
      current: 1,
      counts: { copied: 1, skipped: 0, failed: 0 },
      holder,
    });
    const first = await deliveredIdentity();
    const second = await deliveredIdentity();
    await claimImport(created._id, first, undefined, db);
    await claimImport(created._id, second, undefined, db);

    await expect(
      updateImportProgress(created._id, copied(first), undefined, db),
    ).rejects.toBeInstanceOf(ImportTakenOver);
    expect((await getImport(created._id, db))!.counts.copied).toBe(0);

    await updateImportProgress(created._id, copied(second), undefined, db);
    expect((await getImport(created._id, db))!.counts.copied).toBe(1);
  });
});
