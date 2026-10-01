import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { fromBunSqlite, runMigrations } from './migrate.ts';
import { ALL_MIGRATIONS } from './migrations/index.ts';
import { removeUnusedIndexerQueueMigration } from './migrations/0008-remove-unused-indexer-queue.ts';
import {
  createBlankTestDatabase,
  createTestDatabase,
  testSqliteDb,
} from './test-sqlite.test-helpers.ts';
import { createJob, saveJobCheckpoint, claimJob, getJob } from '../repos/jobs.repo.ts';

const previous = ALL_MIGRATIONS.filter((m) => m.id < removeUnusedIndexerQueueMigration.id);
const queueObjects = "SELECT name FROM sqlite_master WHERE name LIKE 'indexer_queue%'";

test('an existing file upgrades without losing jobs, leases or recovery ledgers', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, previous);
  const repo = testSqliteDb(handle.db);
  const job = await createJob(
    { kind: 'pano_stitch', payload: { assetIds: ['a'] } },
    undefined,
    undefined,
    repo,
  );
  await claimJob('worker', 60_000, undefined, repo);
  await saveJobCheckpoint(job._id, 'worker', { applied: 1 }, 60_000, undefined, undefined, repo);
  const before = await getJob(job._id, repo);
  handle.db.run(
    "INSERT INTO indexer_queue (kind, payload, status, created_at, updated_at) VALUES ('scan_folder', '{}', 'pending', 'n', 'n')",
  );

  const reopened = new Database(handle.path);
  try {
    const applied = await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS);
    const objects = reopened.query(queueObjects).all();
    const after = await getJob(job._id, testSqliteDb(reopened));
    const again = await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS);
    expect(applied.applied).toEqual(ALL_MIGRATIONS.slice(previous.length).map((m) => m.id));
    expect(objects).toEqual([]);
    expect(after).toEqual(before);
    expect(again.applied).toEqual([]);
    expect(reopened.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    reopened.close();
  }
});

test('fresh installs have no unused queue table or index', async () => {
  using handle = await createTestDatabase();
  expect(handle.db.query(queueObjects).all()).toEqual([]);
  expect(handle.db.query('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 0 });
});

test('a failed migration restores the legacy queue and does not record completion', async () => {
  using handle = createBlankTestDatabase();
  await runMigrations(handle.migrationDb, previous);
  handle.db.run(
    "INSERT INTO indexer_queue (kind, payload, status, created_at, updated_at) VALUES ('gen_thumb', '{}', 'pending', 'n', 'n')",
  );
  const failed = {
    ...removeUnusedIndexerQueueMigration,
    async up(db: typeof handle.migrationDb) {
      await removeUnusedIndexerQueueMigration.up(db);
      throw new Error('simulated interrupted upgrade');
    },
  };
  await expect(runMigrations(handle.migrationDb, [...previous, failed])).rejects.toThrow(
    'simulated interrupted upgrade',
  );
  expect(handle.db.query(queueObjects).all()).toHaveLength(2);
  expect(handle.db.query('SELECT kind FROM indexer_queue').all()).toEqual([{ kind: 'gen_thumb' }]);
  expect(
    handle.db.query('SELECT id FROM schema_migrations WHERE id = ?').get(failed.id),
  ).toBeNull();
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(handle.db.query(queueObjects).all()).toEqual([]);
});
