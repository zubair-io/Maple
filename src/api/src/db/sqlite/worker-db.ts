/**
 * A `SqliteDb` for code running inside a Worker that is not one of the pool's
 * own workers — today, the clustering worker (#3749).
 *
 * ## The problem this solves
 *
 * The clustering pass runs on its own thread because it is the one genuinely
 * CPU-bound thing the API does: decoding and normalising tens of thousands of
 * 512-float embeddings, then an O(N·K·D) comparison loop. On Mongo that worker
 * opens **its own database connection**, with the connection parameters handed
 * to it in the dispatch message, so the embeddings are read and processed
 * entirely off the request thread and only a small result crosses back.
 *
 * Carrying that arrangement over unchanged is the trap. A second read-write
 * SQLite connection is a second writer, and the entire pool design rests on
 * there being exactly one — `pool.ts` explains why serialising writes through a
 * single thread is what makes their order defined rather than merely likely.
 * The clustering pass writes: `recomputeCentroids` persists every refreshed
 * centroid before the seeds are read back. So this is not a hypothetical.
 *
 * ## The arrangement
 *
 * Reads and writes are split, because they have opposite requirements.
 *
 * **Reads stay local.** The worker opens the database `readonly`, exactly as a
 * pool reader worker does, and runs its own queries on that connection. WAL
 * allows any number of concurrent readers, so this adds a reader and changes
 * nothing about writer serialisation. It also keeps the embeddings inside the
 * worker: routing reads through the host would clone every vector across
 * `postMessage` twice over, which is the cost the off-thread design exists to
 * avoid. SQLite enforces the restriction itself — a write attempted on this
 * connection fails with `SQLITE_READONLY` rather than relying on this module
 * being used correctly.
 *
 * **Writes go to the pool.** `write` and `transaction` send their statements to
 * the host thread, which runs them on the pool's single writer and replies.
 * Writes are rare and small here — one batch of centroids per pass — so the
 * round trip costs nothing measurable, and the single-writer guarantee holds
 * without qualification.
 *
 * ## Read-after-write is what makes this correct
 *
 * `recomputeCentroids` writes centroids that `loadCentroids` must then read
 * back, and the double normalise across that round trip is part of the numeric
 * path (see `repos/people.cluster-load.ts`). Because the host only replies once
 * the pool's writer has committed, and because each statement on an autocommit
 * WAL reader takes a fresh snapshot, the read that follows an awaited write
 * observes it. Nothing here may buffer or coalesce writes without breaking that.
 *
 * ## Why every reply is deferred by a macrotask
 *
 * Bun 1.4.3 drops a Worker `message` event when a previous round trip's promise
 * was settled synchronously inside the listener: the sender's reply is sent and
 * never delivered, and the process hangs rather than failing. Settling one real
 * macrotask later avoids it; `queueMicrotask` does not, because the boundary has
 * to be a genuine macrotask one. `setImmediate` rather than `setTimeout(fn, 0)`,
 * which inherits a ~1 ms floor. The same defence is in `@justmaple/maple`'s
 * worker pool (#3508) for the same engine bug, which has a standalone repro and
 * is not yet fixed upstream. This design makes several round trips per pass, so
 * it would hit that bug without this.
 */

import { Database } from 'bun:sqlite';
import {
  BUSY_TIMEOUT_MS,
  type SqlParams,
  type SqlRow,
  type SqlStatement,
  type SqlWriteResult,
} from './protocol.ts';
import type { SqliteDb } from '../repos/db-handle.ts';

/** A request from the worker asking the host to run statements on the writer. */
interface WorkerDbRequest {
  type: 'sqlite-db';
  requestId: number;
  /** `write` runs one statement on its own; `transaction` wraps the batch. */
  mode: 'write' | 'transaction';
  statements: readonly SqlStatement[];
}

/** The host's reply. Errors are flattened — an `Error` does not clone cleanly. */
interface WorkerDbResponse {
  type: 'sqlite-db-result';
  requestId: number;
  ok: boolean;
  results?: SqlWriteResult[];
  error?: string;
}

/**
 * The slice of a Worker or of `self` this module needs, on either side of the
 * boundary. Narrow on purpose: it is what lets both halves be driven by a plain
 * object in a test, with no thread involved.
 */
export interface MessageChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener?(type: 'message', listener: (event: MessageEvent) => void): void;
}

function isDbRequest(value: unknown): value is WorkerDbRequest {
  const candidate = value as WorkerDbRequest | undefined;
  return candidate?.type === 'sqlite-db' && typeof candidate.requestId === 'number';
}

function isDbResponse(value: unknown): value is WorkerDbResponse {
  const candidate = value as WorkerDbResponse | undefined;
  return candidate?.type === 'sqlite-db-result' && typeof candidate.requestId === 'number';
}

/** Settle one macrotask later — see the module header. */
function deferSettle(settle: () => void): void {
  setImmediate(settle);
}

/**
 * Serve a worker's database requests from the host thread, running them on
 * `db` — in production the process-wide pool, whose writer is the only one.
 *
 * Returns a function that stops serving. Attaching this is what makes the
 * worker's `write` and `transaction` resolve; a worker whose host never called
 * it would simply wait.
 */
export function serveWorkerDbRequests(channel: MessageChannelLike, db: SqliteDb): () => void {
  const listener = (event: MessageEvent): void => {
    if (!isDbRequest(event.data)) return;
    const request = event.data;
    const run =
      request.mode === 'transaction'
        ? db.transaction(request.statements)
        : runSingle(db, request.statements[0]);
    void run.then(
      (results) => {
        channel.postMessage({
          type: 'sqlite-db-result',
          requestId: request.requestId,
          ok: true,
          results,
        } satisfies WorkerDbResponse);
      },
      (error: unknown) => {
        channel.postMessage({
          type: 'sqlite-db-result',
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies WorkerDbResponse);
      },
    );
  };

  channel.addEventListener('message', listener);
  return () => channel.removeEventListener?.('message', listener);
}

/** One statement, reported in the same array shape a transaction reports. */
async function runSingle(
  db: SqliteDb,
  statement: SqlStatement | undefined,
): Promise<SqlWriteResult[]> {
  if (!statement) return [];
  return [await db.write(statement.sql, statement.params)];
}

/** A worker-side handle, plus the disposal its local connection needs. */
export interface WorkerDb extends SqliteDb {
  close(): void;
}

/**
 * Build the worker's handle: a local read-only connection for queries, and the
 * host channel for writes.
 *
 * The connection is opened lazily on the first read rather than here, so a
 * worker that is spawned and never asked to do anything holds no file handle —
 * and so that a database that does not exist yet fails at the query that needed
 * it, with that query's own error, rather than at construction.
 */
export function createWorkerDb(path: string, channel: MessageChannelLike): WorkerDb {
  const pending = new Map<
    number,
    { resolve: (results: SqlWriteResult[]) => void; reject: (error: Error) => void }
  >();
  let nextRequestId = 1;
  let connection: Database | null = null;

  channel.addEventListener('message', (event: MessageEvent) => {
    if (!isDbResponse(event.data)) return;
    const response = event.data;
    const waiter = pending.get(response.requestId);
    if (!waiter) return;
    pending.delete(response.requestId);
    deferSettle(() => {
      if (response.ok) waiter.resolve(response.results ?? []);
      else waiter.reject(new Error(response.error ?? 'sqlite worker-db: write failed'));
    });
  });

  /**
   * The local reader. `readonly` is the guarantee, not a hint: this is the same
   * mode the pool's reader workers open in, and it is why a stray write here
   * cannot become a second writer even by mistake.
   *
   * The WAL sidecar files must already exist for a read-only connection to
   * attach, which they do — the pool always starts its writer first, and that
   * is what creates them.
   */
  const reader = (): Database => {
    if (connection) return connection;
    const opened = new Database(path, { readonly: true });
    opened.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    connection = opened;
    return opened;
  };

  const send = (mode: 'write' | 'transaction', statements: readonly SqlStatement[]) =>
    new Promise<SqlWriteResult[]>((resolve, reject) => {
      const requestId = nextRequestId++;
      pending.set(requestId, { resolve, reject });
      try {
        channel.postMessage({
          type: 'sqlite-db',
          requestId,
          mode,
          statements,
        } satisfies WorkerDbRequest);
      } catch (error) {
        pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  return {
    read<T = SqlRow>(sql: string, params?: SqlParams): Promise<T[]> {
      try {
        const bound = params === undefined ? [] : Array.isArray(params) ? [...params] : [params];
        return Promise.resolve(
          reader()
            .query(sql)
            .all(...(bound as never[])) as T[],
        );
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    async write(sql: string, params?: SqlParams): Promise<SqlWriteResult> {
      const results = await send('write', [{ sql, params }]);
      return results[0] ?? { changes: 0, lastInsertRowid: 0 };
    },
    transaction(statements: readonly SqlStatement[]): Promise<SqlWriteResult[]> {
      if (statements.length === 0) return Promise.resolve([]);
      return send('transaction', statements);
    },
    close(): void {
      connection?.close();
      connection = null;
    },
  };
}
