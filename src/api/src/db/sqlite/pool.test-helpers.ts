/**
 * Shared scaffolding for the SQLite pool tests: a throwaway database file per
 * test, a query whose cost is set in the SQL text rather than by table size so
 * the timing tests need no fixture data, and a stand-in worker for the failure
 * modes a real thread will not perform on demand — dying, erroring without
 * exiting, and dropping a reply.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqlitePool, type SqlitePoolOptions } from './pool.ts';
import type { SqliteWorkerRequest, SqliteWorkerResponse, SqliteWorkerRole } from './protocol.ts';
import type { SpawnWorker } from './worker-handle.ts';

const created: string[] = [];

/** A path in a fresh temp directory, cleaned up by {@link cleanupTempDatabases}. */
export function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'maple-sqlite-pool-'));
  created.push(dir);
  return join(dir, 'maple.db');
}

export function cleanupTempDatabases(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A pool on a throwaway database. Callers must `close()` it. */
export function openTestPool(options: Partial<SqlitePoolOptions> = {}): Promise<SqlitePool> {
  return SqlitePool.open({ path: tempDatabasePath(), ...options });
}

/**
 * A query that burns CPU inside SQLite for a controllable time — counting to
 * `iterations` through a recursive CTE. Measured on Bun 1.4.3: 15,000,000
 * iterations takes about a second, and the cost is linear below that.
 */
export function countingQuery(iterations: number): string {
  return (
    `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<${iterations}) ` +
    `SELECT count(*) AS n FROM c`
  );
}

/** Roughly one second of SQLite CPU — the query the blocking measurement used. */
export const ONE_SECOND_QUERY = countingQuery(15_000_000);

/**
 * A stand-in for a database worker. It answers the protocol with empty results
 * — the assertions that use it are about routing, liveness and termination,
 * never about rows — and lets a test stage what a real thread cannot be asked
 * to do on cue: exit, raise an `error` without exiting, swallow a request, and
 * answer one long after the pool gave up on it.
 */
export class FakeWorker {
  terminated = false;
  /** Every request the pool posted here, in order. */
  readonly received: SqliteWorkerRequest[] = [];
  private silent = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly role: SqliteWorkerRole) {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  postMessage(request: SqliteWorkerRequest): void {
    this.received.push(request);
    if (this.silent) return;
    queueMicrotask(() => this.emit('message', { data: reply(request) }));
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Stop answering — the dropped-reply shape the request timeout exists for. */
  goSilent(): void {
    this.silent = true;
  }

  /**
   * Answer the request this worker swallowed, after the fact, and start
   * answering again: the reply that lost its race with the pool's timeout.
   */
  deliverLateReply(): void {
    const last = this.received.at(-1);
    this.silent = false;
    if (last) this.emit('message', { data: reply(last) });
  }

  /** The thread exited: a `close` event, and nothing will answer again. */
  exit(): void {
    this.silent = true;
    this.emit('close', {});
  }

  /**
   * An uncaught throw inside the worker: an `error` event, while the thread —
   * and its open database file — carries on running.
   */
  raise(message = 'uncaught error in worker'): void {
    this.emit('error', { message });
  }

  asWorker(): Worker {
    return this as unknown as Worker;
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/**
 * A spawn function backed by {@link FakeWorker}s, plus the ones it created.
 * `silent` starts them dropping every request, including the open handshake.
 */
export function fakeWorkers(options: { silent?: boolean } = {}): {
  spawned: FakeWorker[];
  spawn: SpawnWorker;
} {
  const spawned: FakeWorker[] = [];
  return {
    spawned,
    spawn: (role: SqliteWorkerRole) => {
      const worker = new FakeWorker(role);
      if (options.silent) worker.goSilent();
      spawned.push(worker);
      return worker.asWorker();
    },
  };
}

function reply(request: SqliteWorkerRequest): SqliteWorkerResponse {
  switch (request.kind) {
    case 'read':
      return { kind: 'read', id: request.id, ok: true, rows: [] };
    case 'write':
      return {
        kind: 'write',
        id: request.id,
        ok: true,
        result: { changes: 0, lastInsertRowid: 0 },
      };
    case 'transaction':
      return { kind: 'transaction', id: request.id, ok: true, results: [] };
    default:
      return { kind: 'open', id: request.id, ok: true };
  }
}
