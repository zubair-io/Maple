/**
 * Shared scaffolding for the SQLite pool tests: a throwaway database file per
 * test, and a query whose cost is set in the SQL text rather than by table
 * size, so the timing tests need no fixture data.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqlitePool, type SqlitePoolOptions } from './pool.ts';

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
