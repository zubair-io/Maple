/**
 * Fail-closed startup.
 *
 * `src/api/src/people/cluster-pool.ts` is the precedent for this module's
 * message plumbing, and it degrades to in-process execution when a Worker
 * cannot spawn — fine for an occasional clustering pass. The database every
 * request depends on must not do that: the in-process fallback would block the
 * event loop on every query for the life of the process, so a Self Hosted
 * install would come up "working" and serve a stalled API. These tests pin the
 * opposite behaviour — open throws, nothing is left running, and the pool
 * cannot be used afterwards.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { closeSqlitePool, openSqlitePool, sqlitePool } from './index.ts';
import { SqlitePool } from './pool.ts';
import {
  FakeWorker,
  cleanupTempDatabases,
  fakeWorkers,
  tempDatabasePath,
} from './pool.test-helpers.ts';
import type { SqliteWorkerRole } from './protocol.ts';

afterAll(cleanupTempDatabases);

describe('SqlitePool fails closed', () => {
  test('a writer worker that cannot spawn fails the open', async () => {
    const error = await SqlitePool.open({
      path: tempDatabasePath(),
      spawnWorker: () => {
        throw new Error('Worker is not available in this runtime');
      },
    }).then(
      (pool) => {
        pool.close();
        return null;
      },
      (e: Error) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('failed to spawn writer worker');
    expect(error?.message).toContain('Worker is not available in this runtime');
  });

  test('a reader worker that cannot spawn fails the open and stops the writer', async () => {
    const spawned: FakeWorker[] = [];
    const error = await SqlitePool.open({
      path: tempDatabasePath(),
      readers: 2,
      spawnWorker: (role: SqliteWorkerRole) => {
        if (role === 'reader') throw new Error('thread limit reached');
        const worker = new FakeWorker(role);
        spawned.push(worker);
        return worker.asWorker();
      },
    }).then(
      (pool) => {
        pool.close();
        return null;
      },
      (e: Error) => e,
    );

    expect(error?.message).toContain('failed to spawn reader worker');
    // The writer came up before the reader failed; a failed startup must not
    // leave it running.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.terminated).toBe(true);
  });

  test('a worker that dies during startup fails the open rather than hanging', async () => {
    const error = await SqlitePool.open({
      path: tempDatabasePath(),
      spawnWorker: () => new Worker('file:///maple-sqlite-worker-that-does-not-exist.ts'),
    }).then(
      (pool) => {
        pool.close();
        return null;
      },
      (e: Error) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('sqlite pool: writer worker could not open');
  }, 15_000);

  test('a database file that cannot be opened fails the open', async () => {
    const unopenable = join(tempDatabasePath(), 'no-such-directory', 'maple.db');
    const error = await SqlitePool.open({ path: unopenable }).then(
      (pool) => {
        pool.close();
        return null;
      },
      (e: Error) => e,
    );

    expect(error?.message).toContain('sqlite pool: writer worker could not open');
    expect(error?.message).toContain('unable to open database file');
  });

  test('a database that cannot run in WAL mode fails the open', async () => {
    // `PRAGMA journal_mode = WAL` does not throw when SQLite refuses it — it
    // reports the mode actually in effect. An in-memory database refuses it the
    // same way a network filesystem does, which is the deployment shape this
    // guard exists for: without it the pool comes up "successfully" with
    // readers and writer serialising against each other.
    const error = await SqlitePool.open({ path: ':memory:' }).then(
      (pool) => {
        pool.close();
        return null;
      },
      (e: Error) => e,
    );

    expect(error?.message).toContain('refused WAL mode');
    expect(error?.message).toContain("journal_mode is 'memory'");
  });

  test('a database on ordinary storage is actually in WAL mode', async () => {
    // The control for the test above: the guard must pass a real file, and the
    // readers must see the same mode the writer set.
    const pool = await SqlitePool.open({ path: tempDatabasePath() });
    try {
      const mode = await pool.read<{ journal_mode: string }>('PRAGMA journal_mode');
      expect(mode).toEqual([{ journal_mode: 'wal' }]);
    } finally {
      pool.close();
    }
  });

  test('readers must be a positive integer', async () => {
    const zero = await SqlitePool.open({ path: tempDatabasePath(), readers: 0 }).then(
      (pool) => {
        pool.close();
        return null;
      },
      (e: Error) => e,
    );

    expect(zero?.message).toContain('readers must be a positive integer');
  });
});

describe('process-wide pool handle', () => {
  afterEach(() => closeSqlitePool());

  test('the handle is unusable until startup opens it', () => {
    expect(() => sqlitePool()).toThrow(/not open/);
  });

  test('a failed open leaves no pool behind', async () => {
    const error = await openSqlitePool({
      path: tempDatabasePath(),
      spawnWorker: () => {
        throw new Error('no worker');
      },
    }).then(
      () => null,
      (e: Error) => e,
    );

    expect(error?.message).toContain('failed to spawn writer worker');
    // No silent degradation: there is no pool to fall back onto.
    expect(() => sqlitePool()).toThrow(/not open/);
  });

  test('opening twice is refused so a second writer cannot appear', async () => {
    const path = tempDatabasePath();
    const first = await openSqlitePool({ path });
    const second = await openSqlitePool({ path }).then(
      () => null,
      (e: Error) => e,
    );
    const handle = sqlitePool();

    expect(second?.message).toContain('already open');
    expect(handle).toBe(first);
  });

  test('two callers racing to open produce one pool and one writer', async () => {
    const { spawned, spawn } = fakeWorkers();
    const path = tempDatabasePath();

    // Neither caller awaits before the other starts: the guard has to hold
    // across the await inside openSqlitePool, not just before it.
    const settled = await Promise.allSettled([
      openSqlitePool({ path, spawnWorker: spawn }),
      openSqlitePool({ path, spawnWorker: spawn }),
    ]);
    const opened = settled.filter(
      (result): result is PromiseFulfilledResult<SqlitePool> => result.status === 'fulfilled',
    );
    const refused = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const writers = spawned.filter((worker) => worker.role === 'writer');

    // Two writer connections on one file is the exact thing the single writer
    // worker exists to prevent.
    expect(writers).toHaveLength(1);
    expect(opened).toHaveLength(1);
    expect((refused[0]?.reason as Error | undefined)?.message).toContain('already open');
    expect(opened[0]?.value).toBe(sqlitePool());
  });

  test('a pool closed through the object can be reopened', async () => {
    const path = tempDatabasePath();
    const first = await openSqlitePool({ path, spawnWorker: fakeWorkers().spawn });
    // Closing the object rather than calling closeSqlitePool() must not wedge
    // the module handle: a closed pool holds no threads and no file.
    first.close();
    const second = await openSqlitePool({ path, spawnWorker: fakeWorkers().spawn });

    expect(second).not.toBe(first);
    expect(sqlitePool()).toBe(second);
  });
});
