/**
 * `local_purge_obligations` — files a kept-photo purge still owes the disk
 * (#5403). Recorded inside the transaction that takes the photo out of Trash,
 * removed only once the file is gone.
 */

import type { SqlStatement } from '../sqlite/protocol.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';

/** A file's identity on disk, as decimal strings so 64-bit values survive. */
export interface FileStamp {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
}

export interface LocalPurgeTarget {
  relPath: string;
  ownerRelPath: string;
  kind: 'trash' | 'companion';
  stamp: FileStamp;
}

export interface LocalPurgeObligation {
  id: number;
  asset_id: string;
  library_id: string;
  rel_path: string;
  owner_rel_path: string;
  kind: 'trash' | 'companion';
  attempts: number;
  dev: string;
  ino: string;
  size: string;
  mtime_ns: string;
}

export function recordLocalPurgeStatements(
  assetId: string,
  libraryId: string,
  targets: readonly LocalPurgeTarget[],
): SqlStatement[] {
  return targets.map((target) => ({
    sql: `INSERT INTO local_purge_obligations
            (asset_id, library_id, rel_path, owner_rel_path, kind, dev, ino, size, mtime_ns)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (library_id, rel_path) DO UPDATE SET
            asset_id = excluded.asset_id, owner_rel_path = excluded.owner_rel_path,
            kind = excluded.kind, dev = excluded.dev, ino = excluded.ino, size = excluded.size,
            mtime_ns = excluded.mtime_ns, attempts = 0, next_attempt_at = 0, last_error = NULL`,
    params: [
      assetId,
      libraryId,
      target.relPath,
      target.ownerRelPath,
      target.kind,
      target.stamp.dev,
      target.stamp.ino,
      target.stamp.size,
      target.stamp.mtimeNs,
    ],
  }));
}

/** Obligations due now, optionally only one asset's (drained right after it is kept). */
export function dueLocalPurges(
  now: number,
  assetId?: string,
  dbOverride?: SqliteDb,
): Promise<LocalPurgeObligation[]> {
  return sqliteDb(dbOverride).read<LocalPurgeObligation>(
    `SELECT id, asset_id, library_id, rel_path, owner_rel_path, kind, attempts,
            dev, ino, size, mtime_ns
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
