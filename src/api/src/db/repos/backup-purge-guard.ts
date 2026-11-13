import type { SqlStatement } from '../sqlite/protocol.ts';
import type { SqliteDb } from './db-handle.ts';

/** `statements` in one transaction that writes nothing and answers false when a
 * durable purge intent owns the asset at commit time, rather than at the
 * caller's earlier lookup (#4913). */
export async function transactionUnlessPurged(
  db: SqliteDb,
  assetHex: string,
  statements: readonly SqlStatement[],
): Promise<boolean> {
  try {
    await db.transaction([
      {
        sql: `CREATE TEMP TABLE maple_backup_purge_guard(
          ready INTEGER CONSTRAINT no_admitted_purge CHECK(ready = 1))`,
      },
      {
        sql: `INSERT INTO maple_backup_purge_guard SELECT NOT EXISTS
          (SELECT 1 FROM backup_lifecycle WHERE asset_id = ? AND kind = 'purge')`,
        params: [assetHex],
      },
      ...statements,
      { sql: `DROP TABLE maple_backup_purge_guard` },
    ]);
    return true;
  } catch (err) {
    if (String(err instanceof Error ? err.message : err).includes('no_admitted_purge'))
      return false;
    throw err;
  }
}
