/**
 * Public surface of the SQLite pool, plus the process-wide handle.
 *
 * Callers get one pool per process, opened once during startup and closed on
 * shutdown — the same shape the Mongo client has today, so repository modules
 * can reach a connection without threading it through every signature.
 *
 * `openSqlitePool` is deliberately the only way to get a pool, and it throws
 * rather than degrading when a worker cannot start. Whoever calls it during
 * startup should let that throw propagate: an API that cannot open its
 * database must refuse to start, not serve requests that block the event loop.
 *
 * Nothing calls `openSqlitePool` yet. This slice delivers the pool and its
 * tests only; the schema (#3743), the importer (#3744) and the repository
 * ports land separately, and startup is wired at the cutover (#3752).
 */

import { SqlitePool, type SqlitePoolOptions } from './pool.ts';

export { SqlitePool, type SqlitePoolOptions, type SqlitePoolStats } from './pool.ts';
export type { SqliteWorkerStats } from './worker-handle.ts';
export type { SqlParams, SqlRow, SqlStatement, SqlValue, SqlWriteResult } from './protocol.ts';

import type { SqlParams, SqlRow, SqlStatement, SqlWriteResult } from './protocol.ts';

/**
 * The open pool, and the open that is still spawning its workers. Both are
 * needed: the guard below has to reject a second caller while the first one is
 * still awaiting its threads, which is the window in which `pool` is null.
 */
let opening: Promise<SqlitePool> | null = null;
let openingPath: string | null = null;
let pool: SqlitePool | null = null;

/**
 * Open the process-wide pool. Throws if a worker cannot spawn or the database
 * cannot be opened, and throws if a pool is already open — a second pool on
 * the same file would mean a second writer, which is exactly what the single
 * writer worker exists to prevent.
 *
 * The in-flight open is recorded before the first `await`, so two callers that
 * race cannot both pass the guard: a check-then-await guard would let the
 * second one through and leave the first pool's writer and reader threads
 * running with nothing left holding a reference that could close them.
 *
 * A pool closed through the object rather than through {@link closeSqlitePool}
 * does not block a reopen: it owns no threads and no file handle, so there is
 * nothing for a new pool to collide with, and refusing would wedge the module
 * until the process restarted.
 */
export async function openSqlitePool(options: SqlitePoolOptions): Promise<SqlitePool> {
  if (opening && !pool?.isClosed) {
    throw new Error(`sqlite pool: already open on ${openingPath}`);
  }
  const started = SqlitePool.open(options);
  opening = started;
  openingPath = options.path;
  pool = null;

  try {
    const opened = await started;
    if (opening !== started) {
      // closeSqlitePool() ran while the workers were still coming up. Honour
      // it rather than installing threads the caller has already disowned.
      opened.close();
      throw new Error(`sqlite pool: open of ${options.path} was cancelled by close`);
    }
    pool = opened;
    return opened;
  } catch (e) {
    if (opening === started) {
      opening = null;
      openingPath = null;
    }
    throw e;
  }
}

/** The open pool. Throws if startup never opened one, or if it was closed. */
export function sqlitePool(): SqlitePool {
  if (!pool || pool.isClosed) {
    throw new Error('sqlite pool: not open — openSqlitePool() must run during startup');
  }
  return pool;
}

/**
 * The three primitives a repository needs, which `SqlitePool` satisfies
 * structurally. Declared here rather than imported from `repos/db-handle.ts`
 * because that module imports this one; the two shapes are pinned equal by a
 * test rather than by a shared declaration.
 */
export interface SqliteHandle {
  read<T = SqlRow>(sql: string, params?: SqlParams): Promise<T[]>;
  write(sql: string, params?: SqlParams): Promise<SqlWriteResult>;
  transaction(statements: readonly SqlStatement[]): Promise<SqlWriteResult[]>;
}

/**
 * A handle installed in place of the pool, for tests only.
 *
 * The cutover (#3787) moved every route, worker and enrichment path onto the
 * repositories, so a test that exercises a handler no longer seeds a database
 * it also holds a reference to — the handler reaches the process-wide handle on
 * its own, the same way it does in production. Without a seam for that, every
 * such test would have to open a real worker-backed pool against a temp file,
 * which costs two spawned threads per suite and cannot be an in-memory
 * database at all (each pool worker opens the file by path).
 *
 * Production never sets this: `openSqlitePool` is the only thing startup calls,
 * and it does not touch this binding.
 */
let testHandle: SqliteHandle | null = null;

/**
 * Point the process-wide handle at a test's own connection, and return the
 * previous one so a suite can restore it. Passing `null` clears it.
 */
export function setSqliteHandleForTests(handle: SqliteHandle | null): SqliteHandle | null {
  const previous = testHandle;
  testHandle = handle;
  return previous;
}

/**
 * What {@link sqliteDb} resolves to when a caller supplies no override: the
 * test handle when one is installed, otherwise the open pool.
 */
export function processSqliteHandle(): SqliteHandle {
  return testHandle ?? sqlitePool();
}

/**
 * Whether a query would find a database to run against, without throwing if it
 * would not.
 *
 * The health endpoint reports it, and one preview path uses it to skip a
 * catalogue lookup it can do without. Both used to ask the same question of
 * MongoDB (`isDbConnected`), where the honest answer could be "not right now,
 * ask again" — a remote server can be unreachable for a while and come back.
 * Here it is very nearly a constant: startup opens the pool before it listens
 * and refuses to serve if it cannot, so `false` after boot means the pool was
 * closed, which happens during shutdown.
 */
export function isSqliteOpen(): boolean {
  return testHandle !== null || (pool !== null && !pool.isClosed);
}

/** Close the process-wide pool, if any. Idempotent. */
export function closeSqlitePool(): void {
  pool?.close();
  pool = null;
  opening = null;
  openingPath = null;
}
