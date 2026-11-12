/**
 * `backup_sidecar_sends` — what a backup send carried when the server merged it into
 * other adjustments (#5796). The device keeps what it sent, not the merged sidecar, so
 * its next send is reconciled from these adjustments rather than from the merged ones,
 * which would read another writer's change as the device's to undo.
 *
 * A row is keyed by the history entry the send became, whose id derives from its parent
 * and the sent bytes, so it can never describe other content. Rows of entries the
 * sidecar's history no longer holds are dropped on its next send; a missing row only
 * falls back to the entry's own adjustments.
 */
import type { ObjectId } from '../object-id.ts';
import type { SqlStatement } from '../sqlite/protocol.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';

export interface BackupSidecarKey {
  assetId: ObjectId;
  libraryId: ObjectId;
  sidecarRelPath: string;
}

export async function sentCheckpointOf(
  key: BackupSidecarKey,
  entryId: string,
  dbOverride?: SqliteDb,
): Promise<string | null> {
  const rows = await sqliteDb(dbOverride).read<{ sent_checkpoint: string }>(
    `SELECT sent_checkpoint FROM backup_sidecar_sends
      WHERE library_id = ? AND sidecar_rel_path = ? AND entry_id = ?`,
    [key.libraryId.toHexString(), key.sidecarRelPath, entryId],
  );
  return rows[0]?.sent_checkpoint ?? null;
}

/** Keeps the rows of `retained` entries, and records `sent` when there is one. */
export async function recordBackupSidecarSends(
  key: BackupSidecarKey,
  update: {
    retained: readonly string[];
    sent: { entryId: string; checkpoint: string } | null;
  },
  dbOverride?: SqliteDb,
): Promise<void> {
  const library = key.libraryId.toHexString();
  const statements: SqlStatement[] = [
    {
      sql: `DELETE FROM backup_sidecar_sends
             WHERE library_id = ? AND sidecar_rel_path = ?
               AND entry_id NOT IN (SELECT value FROM json_each(?))`,
      params: [library, key.sidecarRelPath, JSON.stringify(update.retained)],
    },
  ];
  if (update.sent !== null) {
    statements.push({
      sql: `INSERT INTO backup_sidecar_sends
              (library_id, sidecar_rel_path, entry_id, asset_id, sent_checkpoint)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (library_id, sidecar_rel_path, entry_id)
            DO UPDATE SET asset_id = excluded.asset_id`,
      params: [
        library,
        key.sidecarRelPath,
        update.sent.entryId,
        key.assetId.toHexString(),
        update.sent.checkpoint,
      ],
    });
  }
  await sqliteDb(dbOverride).transaction(statements);
}
