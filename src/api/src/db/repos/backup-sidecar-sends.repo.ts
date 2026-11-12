/**
 * `backup_sidecar_sends` — what a backup device sent where the sidecar's edit history
 * cannot show it (#5796): a send the server merged into other adjustments (its row names
 * the entry it became) and a send acknowledged as unchanged (its row names the entry it
 * was acknowledged at, `''` for none). The device keeps what it sent, not the merged
 * sidecar, and names it by digest next time, so that send is reconciled from these
 * adjustments rather than from the merged ones, which would read another writer's change
 * as the device's to undo.
 *
 * Rows belong to the asset, so a renamed or moved photo keeps them. The sent adjustments
 * derive from the digest, so a row never describes other content and a stale one is
 * harmless; a missing one only falls back to the history. Rows are pruned only while the
 * asset has a single location: then that sidecar is the only one that can still hold an
 * entry, and a row its history no longer holds is never named again. With more copies
 * (or one in the Trash, or offline) any of them may, so nothing is pruned; deleting the
 * asset removes its rows.
 */
import type { SentRecord, SentUpdate } from '../../backup/sidecar-history.ts';
import type { ObjectId } from '../object-id.ts';
import type { SqlStatement } from '../sqlite/protocol.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';

/** The asset's sends with digest `sha256`, or kept for entry `entryId`. */
export async function sentRecordsOf(
  assetId: ObjectId,
  query: { sha256: string } | { entryId: string },
  dbOverride?: SqliteDb,
): Promise<SentRecord[]> {
  const [column, value] =
    'sha256' in query ? ['sent_sha256', query.sha256] : ['entry_id', query.entryId];
  return sqliteDb(dbOverride).read<SentRecord>(
    `SELECT sent_sha256 AS sha256, entry_id AS entryId, sent_checkpoint AS checkpoint
       FROM backup_sidecar_sends WHERE asset_id = ? AND ${column} = ?`,
    [assetId.toHexString(), value],
  );
}

/** Records `sent` when there is one, and drops the rows of entries outside `retained`
 * while the asset has a single location. */
export async function recordBackupSidecarSends(
  assetId: ObjectId,
  update: SentUpdate,
  dbOverride?: SqliteDb,
): Promise<void> {
  const asset = assetId.toHexString();
  const statements: SqlStatement[] = [
    {
      sql: `DELETE FROM backup_sidecar_sends
             WHERE asset_id = ? AND entry_id NOT IN (SELECT value FROM json_each(?))
               AND (SELECT COUNT(*) FROM asset_locations WHERE asset_id = ?) = 1`,
      params: [asset, JSON.stringify(update.retained), asset],
    },
  ];
  const { sent } = update;
  if (sent !== null) {
    statements.push({
      sql: `INSERT INTO backup_sidecar_sends (asset_id, sent_sha256, entry_id, sent_checkpoint)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (asset_id, sent_sha256, entry_id) DO NOTHING`,
      params: [asset, sent.sha256, sent.entryId, sent.checkpoint],
    });
  }
  await sqliteDb(dbOverride).transaction(statements);
}
