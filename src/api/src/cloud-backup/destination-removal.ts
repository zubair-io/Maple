import type { SqlStatement } from '../db/sqlite/protocol.ts';

/** Follow a guarded destination delete in the same writer transaction. */
export function removedDestinationStatements(id: string): SqlStatement[] {
  return [
    'backup_google_oauth',
    'backup_google_connections',
    'backup_objects',
    'backup_entries',
    'backup_purges',
  ].map((table) => ({
    sql: `DELETE FROM ${table} WHERE destination_id=? AND NOT EXISTS
      (SELECT 1 FROM backup_destinations WHERE id=?)`,
    params: [id, id],
  }));
}
