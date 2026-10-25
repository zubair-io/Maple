/**
 * `local_purge_obligations` — files a kept-photo purge still owes the disk
 * (#5403). Recorded inside the transaction that takes the photo out of Trash,
 * removed only once the file is gone.
 */

import type { SqlStatement } from '../sqlite/protocol.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';

export interface LocalPurgeTarget {
  relPath: string;
  ownerRelPath: string;
  kind: 'trash' | 'companion';
}

export interface LocalPurgeObligation {
  id: number;
  asset_id: string;
  library_id: string;
  rel_path: string;
  owner_rel_path: string;
  kind: 'trash' | 'companion';
  attempts: number;
}

export function recordLocalPurgeStatements(
  assetId: string,
  libraryId: string,
  targets: readonly LocalPurgeTarget[],
): SqlStatement[] {
  return targets.map((target) => ({
    sql: `INSERT INTO local_purge_obligations (asset_id, library_id, rel_path, owner_rel_path, kind)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (library_id, rel_path) DO UPDATE SET
            asset_id = excluded.asset_id, owner_rel_path = excluded.owner_rel_path,
            kind = excluded.kind, next_attempt_at = 0`,
    params: [assetId, libraryId, target.relPath, target.ownerRelPath, target.kind],
  }));
}

/** Obligations due now, optionally only one asset's (drained right after it is kept). */
export function dueLocalPurges(
  now: number,
  assetId?: string,
  dbOverride?: SqliteDb,
): Promise<LocalPurgeObligation[]> {
  return sqliteDb(dbOverride).read<LocalPurgeObligation>(
    `SELECT id, asset_id, library_id, rel_path, owner_rel_path, kind, attempts
       FROM local_purge_obligations
      WHERE next_attempt_at <= ? AND (? IS NULL OR asset_id = ?)
      ORDER BY id`,
    [now, assetId ?? null, assetId ?? null],
  );
}

export async function completeLocalPurge(id: number, dbOverride?: SqliteDb): Promise<void> {
  await sqliteDb(dbOverride).write(`DELETE FROM local_purge_obligations WHERE id = ?`, [id]);
}

export async function deferLocalPurge(
  id: number,
  nextAttemptAt: number,
  error: string,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `UPDATE local_purge_obligations
        SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?
      WHERE id = ?`,
    [nextAttemptAt, error, id],
  );
}
