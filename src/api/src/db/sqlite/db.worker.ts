/**
 * Bun Worker entry point owning ONE SQLite connection.
 *
 * Why this file exists at all: every in-process SQLite API available to Bun
 * blocks the event loop, including the promise-shaped ones. Measured on Bun
 * 1.4.3 against a query engineered to take one second, counting 10 ms
 * event-loop ticks while it ran — `bun:sqlite` 0 ticks of an expected ~102,
 * `Bun.sql` with a `sqlite://` URL 0 ticks (it is a promise wrapper over the
 * same synchronous engine), `node:sqlite` `DatabaseSync` 0 ticks, and
 * `bun:sqlite` inside a Worker 101 ticks of an expected ~114. There is no
 * in-process async option, so moving the engine onto its own thread is the
 * design rather than an optimisation. The API and the whole worker tier share
 * one Bun process, so a blocking query stalls every concurrent request.
 *
 * Everything here is synchronous on purpose. `postMessage` delivery is
 * ordered, and this handler never awaits, so requests are executed strictly in
 * arrival order. That is what makes a single writer worker a serialisation
 * point: two callers cannot interleave, and a transaction cannot have another
 * statement injected into the middle of it.
 *
 * Roles: the writer opens read-write and owns the WAL pragmas; readers open
 * read-only, so SQLite itself rejects a stray write on a reader instead of the
 * pool relying on callers to route correctly.
 *
 * See `pool.ts` for the manager and `protocol.ts` for the message shapes.
 */

import { Database, type Statement } from 'bun:sqlite';
import {
  BUSY_TIMEOUT_MS,
  STATEMENT_CACHE_LIMIT,
  type SqlParams,
  type SqlRow,
  type SqlStatement,
  type SqlWriteResult,
  type SqliteWorkerRequest,
  type SqliteWorkerResponse,
  type OpenRequest,
  type ReadRequest,
  type TransactionRequest,
  type WriteRequest,
} from './protocol.ts';

let db: Database | null = null;

/**
 * Prepared statements keyed by SQL text, in least-recently-used order (a Map
 * iterates in insertion order, and a hit re-inserts). Evicted statements are
 * finalized so SQLite releases them — dropping the reference alone would leave
 * the handle alive until GC.
 */
const statements = new Map<string, Statement>();

self.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as SqliteWorkerRequest | undefined;
  if (!request || typeof request.id !== 'number') return;
  self.postMessage(handle(request));
});

function handle(request: SqliteWorkerRequest): SqliteWorkerResponse {
  try {
    switch (request.kind) {
      case 'open':
        return handleOpen(request);
      case 'read':
        return handleRead(request);
      case 'write':
        return handleWrite(request);
      case 'transaction':
        return handleTransaction(request);
      default:
        return failure(request, new Error(`unknown request kind`));
    }
  } catch (e) {
    return failure(request, e);
  }
}

function handleOpen(request: OpenRequest): SqliteWorkerResponse {
  if (db) throw new Error('connection already open');
  const opened =
    request.role === 'writer'
      ? new Database(request.path, { create: true })
      : new Database(request.path, { readonly: true });
  // Writer-only pragmas: WAL is a persistent property of the file, and a
  // read-only connection may not change it. WAL is what lets the readers run
  // while a write is in flight, so a multi-hundred-millisecond facet query
  // cannot delay a grid page.
  if (request.role === 'writer') {
    opened.run('PRAGMA journal_mode = WAL');
    opened.run('PRAGMA synchronous = NORMAL');
    opened.run('PRAGMA foreign_keys = ON');
    // Force the shared-memory index (`-shm`) and write-ahead log (`-wal`) into
    // existence before any reader attaches. A read-only connection cannot
    // create them — it would fail with SQLITE_CANTOPEN on a brand-new database
    // that has only ever been opened, never queried. One read transaction on
    // the writer is enough, and the pool always starts the writer first.
    opened.query('SELECT count(*) AS n FROM sqlite_schema').get();
  }
  opened.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db = opened;
  return { kind: 'open', id: request.id, ok: true };
}

function handleRead(request: ReadRequest): SqliteWorkerResponse {
  const rows = prepared(request.sql).all(...args(request.params)) as SqlRow[];
  return { kind: 'read', id: request.id, ok: true, rows };
}

function handleWrite(request: WriteRequest): SqliteWorkerResponse {
  return { kind: 'write', id: request.id, ok: true, result: run(request) };
}

/**
 * All-or-nothing batch. `BEGIN IMMEDIATE` takes the write lock up front rather
 * than upgrading mid-transaction, which is the right choice on the single
 * writer: there is no second writer to contend with, and it turns a lock
 * conflict with an external process into an immediate error instead of a
 * failure part-way through the batch. Any statement throwing rolls the whole
 * batch back and the error propagates to the caller.
 */
function handleTransaction(request: TransactionRequest): SqliteWorkerResponse {
  const database = connection();
  database.run('BEGIN IMMEDIATE');
  const results: SqlWriteResult[] = [];
  try {
    for (const statement of request.statements) results.push(run(statement));
    database.run('COMMIT');
  } catch (e) {
    rollback(database);
    throw e;
  }
  return { kind: 'transaction', id: request.id, ok: true, results };
}

/** Best-effort unwind. A failed ROLLBACK must not mask the original error. */
function rollback(database: Database): void {
  try {
    database.run('ROLLBACK');
  } catch {
    // The transaction was already unwound by SQLite (or the connection is
    // gone); either way the caller's error is the one worth reporting.
  }
}

function run(statement: SqlStatement): SqlWriteResult {
  const result = prepared(statement.sql).run(...args(statement.params));
  return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
}

/**
 * Normalise bound parameters to the varargs shape `bun:sqlite` expects:
 * positional values spread one per placeholder, named values passed as a
 * single object.
 */
function args(params: SqlParams | undefined): never[] {
  if (params === undefined) return [];
  return (Array.isArray(params) ? [...params] : [params]) as never[];
}

function prepared(sql: string): Statement {
  const hit = statements.get(sql);
  if (hit) {
    // Re-insert so the LRU order reflects this use.
    statements.delete(sql);
    statements.set(sql, hit);
    return hit;
  }
  const statement = connection().prepare(sql);
  statements.set(sql, statement);
  if (statements.size > STATEMENT_CACHE_LIMIT) evictOldest();
  return statement;
}

function evictOldest(): void {
  const oldest = statements.keys().next();
  if (oldest.done) return;
  const statement = statements.get(oldest.value);
  statements.delete(oldest.value);
  statement?.finalize();
}

function connection(): Database {
  if (!db) throw new Error('connection is not open');
  return db;
}

function failure(request: SqliteWorkerRequest, e: unknown): SqliteWorkerResponse {
  const code =
    typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
      ? e.code
      : undefined;
  return {
    kind: request.kind,
    id: request.id,
    ok: false,
    error: e instanceof Error ? e.message : String(e),
    ...(code ? { code } : {}),
  };
}
