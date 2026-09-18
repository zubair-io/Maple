/**
 * `backup_sessions` — the SQLite port of `db/backup-sessions.repo.ts` (#3751).
 *
 * One row per (library, device) summarising cumulative PhotoKit backup
 * progress from that device, so a client can render "X% done from this device"
 * without touching the assets table.
 *
 * Exported as an object rather than as loose functions because the Mongo module
 * is (`backupSessionsRepo.upsertProgress(…)`), and the cutover (#3752) is meant
 * to be an import swap.
 *
 * ## Why the upsert is one statement
 *
 * The Mongo update combines three operators on the natural key: `$inc` for the
 * two counters, `$set` for the progress timestamp and the optional total, and
 * `$setOnInsert` for `started_at`. `INSERT … ON CONFLICT (library_id,
 * device_id) DO UPDATE` expresses all three at once — the insert branch carries
 * the `$setOnInsert` half, the conflict branch reads `excluded.x` for a `$set`
 * and `x + excluded.x` for an `$inc`, and `started_at` is simply absent from
 * the conflict branch, which is what makes it insert-only.
 *
 * Doing it as read-modify-write instead would lose a concurrent upload's
 * increment, and the two ingest paths that call this run concurrently by
 * design.
 *
 * ## Timestamps
 *
 * `BackupSessionDoc` declares `started_at` and `last_progress_at` as `Date`.
 * The columns are ISO TEXT like every other timestamp in this schema, so
 * {@link toDate} converts on the way out.
 */

import type { ObjectId } from 'mongodb';
import type { BackupSessionDoc } from '../../schema.ts';
import { newObjectIdHex } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso, toDate, toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';
export type { BackupSessionDoc };

interface SessionRow {
  id: string;
  library_id: string;
  device_id: string;
  started_at: string;
  last_progress_at: string;
  total_count: number;
  uploaded_count: number;
  failed_count: number;
}

const SELECT_SQL = `
  SELECT id, library_id, device_id, started_at, last_progress_at,
         total_count, uploaded_count, failed_count
    FROM backup_sessions
   WHERE library_id = ? AND device_id = ?`;

function toDoc(row: SessionRow): BackupSessionDoc {
  return {
    _id: toObjectId(row.id),
    library_id: toObjectId(row.library_id),
    device_id: row.device_id,
    started_at: toDate(row.started_at),
    last_progress_at: toDate(row.last_progress_at),
    total_count: row.total_count,
    uploaded_count: row.uploaded_count,
    failed_count: row.failed_count,
  };
}

/**
 * The upsert, with the `total_count` assignment present only when the caller
 * supplied one.
 *
 * A caller that omits `totalCount` must leave an existing total alone — it is
 * the device's declared batch size, and a progress ping that does not carry it
 * is not evidence that it changed. Binding `excluded.total_count`
 * unconditionally would overwrite it with the insert branch's 0.
 */
function upsertSql(setsTotal: boolean): string {
  return `
  INSERT INTO backup_sessions
    (id, library_id, device_id, started_at, last_progress_at,
     total_count, uploaded_count, failed_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (library_id, device_id) DO UPDATE SET
    last_progress_at = excluded.last_progress_at,
    uploaded_count = uploaded_count + excluded.uploaded_count,
    failed_count = failed_count + excluded.failed_count${
      setsTotal ? `,\n    total_count = excluded.total_count` : ''
    }`;
}

export const backupSessionsRepo = {
  /**
   * Fold one upload batch's outcome into the (library, device) row, creating
   * it on first contact.
   *
   * A row created without a `totalCount` gets 0 rather than no column at all,
   * which is the closest honest equivalent to the absent Mongo field: the
   * column is `NOT NULL DEFAULT 0` and every reader already treats a missing
   * total as "unknown, show the counters".
   */
  async upsertProgress(
    args: {
      libraryId: ObjectId;
      deviceId: string;
      uploadedDelta: number;
      failedDelta: number;
      totalCount?: number;
    },
    dbOverride?: SqliteDb,
  ): Promise<void> {
    if (args.uploadedDelta < 0 || args.failedDelta < 0) {
      throw new Error('backupSessionsRepo.upsertProgress: deltas must be >= 0');
    }
    const now = nowIso();
    await sqliteDb(dbOverride).write(upsertSql(args.totalCount !== undefined), [
      newObjectIdHex(),
      args.libraryId.toHexString(),
      args.deviceId,
      now,
      now,
      args.totalCount ?? 0,
      args.uploadedDelta,
      args.failedDelta,
    ]);
  },

  /** The session row for one (library, device), or `null`. */
  async findOne(
    args: { libraryId: ObjectId; deviceId: string },
    dbOverride?: SqliteDb,
  ): Promise<BackupSessionDoc | null> {
    const rows = await sqliteDb(dbOverride).read<SessionRow>(SELECT_SQL, [
      args.libraryId.toHexString(),
      args.deviceId,
    ]);
    const row = rows[0];
    return row === undefined ? null : toDoc(row);
  },
};
