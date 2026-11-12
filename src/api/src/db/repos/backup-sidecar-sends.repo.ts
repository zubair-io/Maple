/**
 * `backup_sidecar_sends` — what a backup device sent where the sidecar's edit history
 * cannot show it (#5796): a send the server merged into other adjustments (its row names
 * the entry it became) and a send acknowledged as unchanged (its row names the entry it
 * was acknowledged at, `''` for none). The device keeps what it sent, not the merged
 * sidecar, and names it by digest next time, so that send is reconciled from these
 * adjustments rather than from the merged ones, which would read another writer's change
 * as the device's to undo.
 *
 * Rows belong to the asset, so a renamed or moved photo keeps them. A row's sidecar is
 * the one that last held its entry: each send adopts the rows of the entries its history
 * holds and drops that sidecar's others. The sent adjustments derive from the digest, so
 * a row never describes other content; a missing row only falls back to the history.
 */
import type { SentRecord, SentUpdate } from '../../backup/sidecar-history.ts';
import type { ObjectId } from '../object-id.ts';
import type { SqlStatement } from '../sqlite/protocol.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';

export interface BackupSidecarKey {
  assetId: ObjectId;
  libraryId: ObjectId;
  sidecarRelPath: string;
}

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

/** The sidecar takes the rows of the `retained` entries its history holds and drops its
 * others; `sent` is recorded when there is one. */
export async function recordBackupSidecarSends(
  key: BackupSidecarKey,
  update: SentUpdate,
  dbOverride?: SqliteDb,
): Promise<void> {
  const asset = key.assetId.toHexString();
  const library = key.libraryId.toHexString();
  const retained = JSON.stringify(update.retained);
  const statements: SqlStatement[] = [
    {
      sql: `UPDATE backup_sidecar_sends SET library_id = ?, sidecar_rel_path = ?
             WHERE asset_id = ? AND entry_id IN (SELECT value FROM json_each(?))`,
      params: [library, key.sidecarRelPath, asset, retained],
    },
    {
      sql: `DELETE FROM backup_sidecar_sends
             WHERE asset_id = ? AND library_id = ? AND sidecar_rel_path = ?
               AND entry_id NOT IN (SELECT value FROM json_each(?))`,
      params: [asset, library, key.sidecarRelPath, retained],
    },
  ];
  const { sent } = update;
  if (sent !== null) {
    statements.push({
      sql: `INSERT INTO backup_sidecar_sends
              (asset_id, sent_sha256, entry_id, sent_checkpoint, library_id, sidecar_rel_path)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (asset_id, sent_sha256, entry_id) DO UPDATE SET
              library_id = excluded.library_id, sidecar_rel_path = excluded.sidecar_rel_path`,
      params: [asset, sent.sha256, sent.entryId, sent.checkpoint, library, key.sidecarRelPath],
    });
  }
  await sqliteDb(dbOverride).transaction(statements);
}
