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

let pool: SqlitePool | null = null;

/**
 * Open the process-wide pool. Throws if a worker cannot spawn or the database
 * cannot be opened, and throws if a pool is already open — a second pool on
 * the same file would mean a second writer, which is exactly what the single
 * writer worker exists to prevent.
 */
export async function openSqlitePool(options: SqlitePoolOptions): Promise<SqlitePool> {
  if (pool) {
    throw new Error(`sqlite pool: already open on ${pool.path}`);
  }
  pool = await SqlitePool.open(options);
  return pool;
}

/** The open pool. Throws if startup never opened one. */
export function sqlitePool(): SqlitePool {
  if (!pool) {
    throw new Error('sqlite pool: not open — openSqlitePool() must run during startup');
  }
  return pool;
}

/** Close the process-wide pool, if any. Idempotent. */
export function closeSqlitePool(): void {
  pool?.close();
  pool = null;
}
