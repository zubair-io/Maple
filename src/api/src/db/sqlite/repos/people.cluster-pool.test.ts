/**
 * The clustering worker, running for real (#3749).
 *
 * `worker-db.test.ts` checks the arrangement with both ends driven by a plain
 * object. This file spawns the actual Worker against an actual database, which
 * is what settles the ticket's second exit criterion: every write the pass
 * performs arrives at the host, so the worker holds no writer of its own.
 *
 * The proof is a counting host handle rather than an inspection of the worker's
 * connection. "The worker did not open a writer" and "every write this pass
 * made came through the host" are the same statement seen from the two ends,
 * and only the second one can be observed from outside the thread: if the
 * worker had written anything directly, the rows would be there and the counter
 * would not have seen them.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import { serveWorkerDbRequests, type MessageChannelLike } from '../worker-db.ts';
import { prepareClusteringPass } from './people.cluster-load.ts';
import {
  insertFace,
  insertLibrary,
  insertLiveAsset,
  insertPerson,
  nearAxis,
  testDb,
} from './people.test-helpers.ts';
import type { SqliteDb } from './db-handle.ts';
import type { SqlStatement, SqlWriteResult } from '../protocol.ts';
import type { PreparedClusteringPass } from './people.cluster-load.ts';

interface PrepareReply {
  type: 'prepare';
  id: number;
  ok: boolean;
  result?: PreparedClusteringPass;
  error?: string;
}

/** A handle that records every statement the worker asks the host to run. */
function countingHost(inner: SqliteDb): { db: SqliteDb; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    db: {
      read: (sql, params) => inner.read(sql, params),
      write: (sql, params): Promise<SqlWriteResult> => {
        writes.push(sql);
        return inner.write(sql, params);
      },
      transaction: (statements: readonly SqlStatement[]): Promise<SqlWriteResult[]> => {
        writes.push(...statements.map((statement) => statement.sql));
        return inner.transaction(statements);
      },
    },
  };
}

let spawned: Worker | null = null;

afterEach(() => {
  spawned?.terminate();
  spawned = null;
});

/**
 * Run one pass on a real worker against `path`, serving its database requests
 * from `host`.
 *
 * Resolution is deferred by a macrotask for the same Bun 1.4.3 message-drop bug
 * the production pool defends against: a pass makes several round trips before
 * this reply, which is exactly the shape that triggers it.
 */
function runOnWorker(
  path: string,
  host: SqliteDb,
  similarityThreshold: number,
): Promise<PreparedClusteringPass> {
  const worker = new Worker(new URL('./people.cluster.worker.ts', import.meta.url).href);
  spawned = worker;
  serveWorkerDbRequests(worker as unknown as MessageChannelLike, host);

  return new Promise<PreparedClusteringPass>((resolve, reject) => {
    worker.addEventListener('message', (event) => {
      const message = event.data as PrepareReply | undefined;
      if (message?.type !== 'prepare') return;
      setImmediate(() => {
        if (message.ok && message.result) resolve(message.result);
        else reject(new Error(message.error ?? 'clustering failed'));
      });
    });
    worker.addEventListener('error', (event) => {
      reject(new Error(`worker errored — ${event.message || 'unknown'}`));
    });
    worker.postMessage({ type: 'prepare', id: 1, similarityThreshold, path });
  });
}

/**
 * A library whose centroid is stale, so the pass has to write before it reads.
 *
 * A fixture with nothing to recompute would let a worker that could not write
 * at all pass every assertion here.
 */
function seedStaleLibrary(handle: Awaited<ReturnType<typeof createTestDatabase>>): void {
  const db = handle.db;
  const libraryId = insertLibrary(db);
  const personId = insertPerson(db, {
    name: 'Ada',
    centroid: nearAxis(0, 0.4),
    centroidFaceCount: -1,
  });
  const first = insertLiveAsset(db, libraryId);
  const second = insertLiveAsset(db, libraryId);
  const third = insertLiveAsset(db, libraryId);
  insertFace(db, { assetId: first, embedding: nearAxis(0, 0.03), personId });
  insertFace(db, { assetId: second, embedding: nearAxis(0, 0.06), personId });
  insertFace(db, { assetId: third, embedding: nearAxis(0, 0.09) });
}

describe('the clustering worker', () => {
  test('completes a pass and routes every write through the host', async () => {
    using handle = await createTestDatabase('file');
    seedStaleLibrary(handle);
    const { db, writes } = countingHost(testDb(handle.db));

    const pass = await runOnWorker(handle.path, db, 0.5);

    // The pass recomputed the stale centroid, and that write reached the host.
    expect(pass.recomputed).toBe(1);
    expect(writes.some((sql) => sql.includes('UPDATE people SET centroid'))).toBe(true);
    // Nothing was written behind the host's back: the stored centroid is the
    // one the host was asked to write.
    const stored = handle.db.query('SELECT centroid_face_count AS n FROM people').get() as {
      n: number;
    };
    expect(stored.n).toBe(2);
    expect(pass.assignments).toHaveLength(1);
  });

  test('produces the same result as the in-process path on the same input', async () => {
    using onWorker = await createTestDatabase('file');
    using inProcess = await createTestDatabase('file');
    seedStaleLibrary(onWorker);
    seedStaleLibrary(inProcess);

    // Both sides run before any assertion. An `expect` between two worker round
    // trips is the documented trigger for the Bun message-drop bug, and the
    // fix for a test that hits it is to restructure rather than to wait.
    const { db } = countingHost(testDb(onWorker.db));
    const workerPass = await runOnWorker(onWorker.path, db, 0.5);
    const localPass = await prepareClusteringPass(0.5, testDb(inProcess.db));

    expect(workerPass.assignments).toEqual(localPass.assignments);
    expect(workerPass.seedCount).toBe(localPass.seedCount);
    expect(workerPass.recomputed).toBe(localPass.recomputed);
    expect(workerPass.clusters.map((cluster) => cluster.face_count)).toEqual(
      localPass.clusters.map((cluster) => cluster.face_count),
    );
    for (const [index, cluster] of localPass.clusters.entries()) {
      expect(workerPass.clusters[index]!.centroid).toEqual(cluster.centroid);
    }
  });

  test('reports the failure rather than hanging when the host refuses a write', async () => {
    using handle = await createTestDatabase('file');
    seedStaleLibrary(handle);

    // A host whose writer rejects stands in for a writer that is gone. The
    // worker has no fallback connection to fall back onto, which is the point:
    // it surfaces the error instead of quietly writing on its own.
    const refusing: SqliteDb = {
      read: (sql, params) => testDb(handle.db).read(sql, params),
      write: () => Promise.reject(new Error('writer unavailable')),
      transaction: () => Promise.reject(new Error('writer unavailable')),
    };

    await expect(runOnWorker(handle.path, refusing, 0.5)).rejects.toThrow(/writer unavailable/);
    const untouched = handle.db.query('SELECT centroid_face_count AS n FROM people').get() as {
      n: number;
    };
    expect(untouched.n).toBe(-1);
  });
});
