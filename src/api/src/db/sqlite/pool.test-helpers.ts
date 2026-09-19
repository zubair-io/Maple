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
 *
 * ## Why six of its members carry a dead-code suppression
 *
 * Every one of them is called; the analysis cannot see it, for two different
 * reasons, and deleting any would break `pool.resilience.test.ts` on the next
 * run.
 *
 * Three are never named by a caller at all: the pool talks to whatever
 * `asWorker()` hands it, which is the structural `Worker` interface, so the
 * call site's type is `Worker` and this class is not mentioned. The other
 * three are called from the resilience suite through a binding the analysis
 * does not resolve back to this class — `spawned[1]` is `FakeWorker |
 * undefined`, and the `for...of` over `spawned.filter(...)` fares no better.
 * `goSilent` is the tell: it is called exactly the way the flagged three are
 * and is NOT flagged, because this file happens to call it as well.
 *
 * Each member says which of the two it is, per the exit criteria on #3789: a
 * suppression that names the symbol rather than one that covers the file.
 */
export class FakeWorker {
  terminated = false;
  /** Every request the pool posted here, in order. */
  readonly received: SqliteWorkerRequest[] = [];
  /** The thread is gone — set by {@link exit} and by a kill that lands first. */
  private exited = false;
  private silent = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly role: SqliteWorkerRole) {}

  // fallow-ignore-next-line unused-class-member -- called by worker-handle.ts through the structural `Worker` that `asWorker()` returns
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  // fallow-ignore-next-line unused-class-member -- same: the pool posts to a `Worker`, never to a `FakeWorker`
  postMessage(request: SqliteWorkerRequest): void {
    this.received.push(request);
    if (this.silent) return;
    queueMicrotask(() => this.emit('message', { data: reply(request) }));
  }

  /**
   * Kill the thread, and emit the `close` a real `Worker` emits when killed.
   *
   * Two behaviours, and getting either wrong hides or invents a bug. A thread
   * that is *still running* when it is killed fires `close`; one that has
   * already exited does not fire a second time — checked against a real
   * `Worker` on Bun 1.4.3, not assumed.
   *
   * The first half is the one that matters, and this fake used to terminate
   * silently, which hid a real defect in `restart()` for a whole review cycle:
   * the corpse of a worker that raised `error` without exiting is still alive
   * when the respawn kills it, and its `close` lands on a handle that has just
   * cleared its death flag for the replacement.
   */
  // fallow-ignore-next-line unused-class-member -- same: `SqlitePool.close()` terminates a `Worker`
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.silent = true;
    if (this.exited) return;
    this.exited = true;
    // A real thread does not stop between one statement and the next; the event
    // arrives on a later turn of the loop, which is the window the bug lives in.
    setTimeout(() => this.emit('close', {}), 0);
  }

  /** Stop answering — the dropped-reply shape the request timeout exists for. */
  goSilent(): void {
    this.silent = true;
  }

  /**
   * Answer the request this worker swallowed, after the fact, and start
   * answering again: the reply that lost its race with the pool's timeout.
   */
  // fallow-ignore-next-line unused-class-member -- called by pool.resilience.test.ts as `reader?.deliverLateReply()`
  deliverLateReply(): void {
    const last = this.received.at(-1);
    this.silent = false;
    if (last) this.emit('message', { data: reply(last) });
  }

  /** The thread exited: a `close` event, and nothing will answer again. */
  // fallow-ignore-next-line unused-class-member -- called by pool.resilience.test.ts, both as `first?.exit()` and in a `for...of` over `spawned.filter(...)`
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    this.silent = true;
    this.emit('close', {});
  }

  /**
   * An uncaught throw inside the worker: an `error` event, while the thread —
   * and its open database file — carries on running.
   */
  // fallow-ignore-next-line unused-class-member -- called by pool.resilience.test.ts as `writer?.raise()`
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
