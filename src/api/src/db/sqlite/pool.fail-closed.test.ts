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
import { cleanupTempDatabases, tempDatabasePath } from './pool.test-helpers.ts';
import type { SqliteWorkerRole } from './protocol.ts';

afterAll(cleanupTempDatabases);

/**
 * A stand-in worker that answers the open handshake and records termination.
 * It exists to prove a failed startup leaves no thread behind — the assertion
 * needs a handle on the worker the pool created, which a real Worker does not
 * give up.
 */
class RecordingWorker {
  terminated = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  postMessage(message: { kind: string; id: number }): void {
    queueMicrotask(() => {
      for (const listener of this.listeners.get('message') ?? []) {
        listener({ data: { kind: message.kind, id: message.id, ok: true } });
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

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
    const spawned: RecordingWorker[] = [];
    const error = await SqlitePool.open({
      path: tempDatabasePath(),
      readers: 2,
      spawnWorker: (role: SqliteWorkerRole) => {
        if (role === 'reader') throw new Error('thread limit reached');
        const worker = new RecordingWorker();
        spawned.push(worker);
        return worker as unknown as Worker;
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
});
