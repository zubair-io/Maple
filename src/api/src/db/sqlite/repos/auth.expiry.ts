/**
 * The expiry sweep that replaces MongoDB's TTL monitor (#3751).
 *
 * Seven tables used to have their old rows removed for them: six auth tables
 * with a TTL index on `expires_at`, plus `upload_sessions`. SQLite has no such
 * background collector, so the deletion becomes an explicit periodic pass and
 * this is it. Each of those tables carries an index on `expires_at` —
 * `EXPIRY_INDEX_DDL` in `../ddl/auth.ts` and `UPLOAD_SESSIONS_INDEX_DDL` in
 * `../ddl/operations.ts` — so every statement below is a range scan over the
 * expired rows rather than a walk of the table.
 *
 * ## This is garbage collection, not enforcement
 *
 * Nothing's security depends on the sweep running. Every one of these tables
 * already had to treat expiry as a read-time condition, because Mongo's TTL
 * monitor only wakes once a minute and an expired document is fully readable
 * until it fires. So each repository's own predicate — `expires_at > ?` in the
 * redeem, the rotate and the capability lookup — is what actually refuses an
 * expired row, and it keeps refusing it whether or not the sweeper ever runs.
 * What the sweep buys is that the tables stay small.
 *
 * Which is also why one table's failure does not abort the pass: a locked or
 * missing table is a reason to report and carry on, not a reason to leave the
 * other six growing.
 *
 * The cutover (#3752) schedules this; nothing calls it yet.
 */

import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/**
 * The tables whose rows expire, in the order the sweep visits them.
 *
 * `challenges` first because it churns fastest — one row per ceremony, five
 * minutes each — and `refresh_tokens` last because its rows live ninety days
 * and there is rarely anything to remove.
 */
export const EXPIRING_TABLES = [
  'challenges',
  'native_auth_codes',
  'lan_handoff_codes',
  'image_access_tokens',
  'invites',
  'upload_sessions',
  'refresh_tokens',
] as const;

export type ExpiringTable = (typeof EXPIRING_TABLES)[number];

/** How many rows the pass removed from each table it visited. */
export type SweepCounts = Record<ExpiringTable, number>;

/** What one pass did, including anything it could not do. */
export interface SweepResult {
  removed: SweepCounts;
  /** Total across every table — what an operator log line wants. */
  total: number;
  /** Tables that failed, with the reason. Empty on a clean pass. */
  failures: Array<{ table: ExpiringTable; error: string }>;
}

/**
 * Delete every row that expired before `cutoff`, table by table.
 *
 * `cutoff` defaults to now and is injectable so a test can pin it rather than
 * sleep. ISO 8601 in UTC sorts lexically, so the string comparison below is a
 * correct chronological range.
 */
export async function sweepExpiredAuthRows(
  cutoff: string = nowIso(),
  dbOverride?: SqliteDb,
): Promise<SweepResult> {
  const db = sqliteDb(dbOverride);
  const removed = Object.fromEntries(EXPIRING_TABLES.map((table) => [table, 0])) as SweepCounts;
  const failures: SweepResult['failures'] = [];

  for (const table of EXPIRING_TABLES) {
    try {
      const result = await db.write(`DELETE FROM ${table} WHERE expires_at < ?`, [cutoff]);
      removed[table] = result.changes;
    } catch (e) {
      failures.push({ table, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const total = EXPIRING_TABLES.reduce((sum, table) => sum + removed[table], 0);
  return { removed, total, failures };
}
