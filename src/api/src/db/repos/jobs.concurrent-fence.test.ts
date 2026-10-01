import { expect, test } from 'bun:test';
import { createTestDatabase } from '../sqlite/test-sqlite.test-helpers.ts';
import { SqlitePool } from '../sqlite/pool.ts';
import {
  createJob,
  failJob,
  resumeBatchJob,
  JobConflictError,
  jobConflictMessage,
} from './jobs.repo.ts';

const input = { kind: 'batch_adjustment_sync' as const, payload: { targets: [] } };

test('concurrent overlapping batches in separate pools have exactly one winner', async () => {
  using handle = await createTestDatabase('file');
  const first = await SqlitePool.open({ path: handle.path, readers: 1 });
  const second = await SqlitePool.open({ path: handle.path, readers: 1 });
  try {
    const results = await Promise.allSettled([
      createJob(input, undefined, ['/library/one', '/library/shared'], first),
      createJob(input, undefined, ['/library/shared', '/library/two'], second),
    ]);
    const rows = await first.read<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')",
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(JobConflictError);
    expect(jobConflictMessage(rejected[0]?.reason)).toBe(
      'Another settings batch is active in this library. Wait for it or cancel it first.',
    );
    expect(rows).toEqual([{ n: 1 }]);
  } finally {
    first.close();
    second.close();
  }
}, 30_000);

test('concurrent resumes cannot reacquire the same library twice', async () => {
  using handle = await createTestDatabase('file');
  const first = await SqlitePool.open({ path: handle.path, readers: 1 });
  const second = await SqlitePool.open({ path: handle.path, readers: 1 });
  try {
    const a = await createJob(input, undefined, ['/library/shared'], first);
    await failJob(a._id, 'interrupted', undefined, undefined, first);
    const b = await createJob(input, undefined, ['/library/shared'], second);
    await failJob(b._id, 'interrupted', undefined, undefined, second);
    const results = await Promise.all([
      resumeBatchJob(a._id, first),
      resumeBatchJob(b._id, second),
    ]);
    const rows = await first.read<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')",
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(rows).toEqual([{ n: 1 }]);
  } finally {
    first.close();
    second.close();
  }
}, 30_000);
