import type { SqliteDb } from '../db/repos/db-handle.ts';
import type { BackupDestination } from './repository.ts';

export interface DestinationStatus {
  pending: number;
  missing: number;
  prepared: number;
  verified: number;
  trash: number;
  blocked: number;
  bytes: number;
  lastError: string | null;
  lastErrorCount: number;
  purgePending: number;
}

interface Counts {
  pending: number;
  verified: number;
  trash: number;
  blocked: number;
  covered: number;
  bytes: number;
  live: number;
  missing: number;
  prepared: number;
}

// One statement, so the library's live locations and the destination's covered
// entries come from the same snapshot; their difference is the Drive backlog.
async function counts(
  db: Pick<SqliteDb, 'read'>,
  destination: Pick<BackupDestination, 'id' | 'libraryId'>,
) {
  const [row] = await db.read<Counts>(
    `SELECT COALESCE(c.pending,0) AS pending,COALESCE(c.verified,0) AS verified,
    COALESCE(c.trash,0) AS trash,COALESCE(c.blocked,0) AS blocked,
    COALESCE(c.covered,0) AS covered,COALESCE(c.bytes,0) AS bytes,
    COALESCE((SELECT live_locations FROM backup_coverage_counts WHERE library_id=?2),0) AS live,
    (SELECT COUNT(*) FROM asset_locations
      WHERE library_id=?2 AND missing_since IS NOT NULL)
      + (SELECT COUNT(*) FROM assets AS a INDEXED BY assets_reaped
        CROSS JOIN asset_locations l ON l.asset_id=a.id
        WHERE a.deleted_reason='reaped' AND l.library_id=?2 AND l.missing_since IS NULL) AS missing,
    (SELECT COUNT(*) FROM backup_lifecycle WHERE library_id=?2 AND phase='prepared') AS prepared
    FROM (SELECT 1) LEFT JOIN backup_entry_counts c ON c.destination_id=?1`,
    [destination.id, destination.libraryId],
  );
  if (!row) throw new Error('Backup status query failed');
  return row;
}

// The error most entries share is what holds the queue; ties go to the one
// retried most recently, so a fresh failure outranks a stale one.
async function dominantError(db: Pick<SqliteDb, 'read'>, destinationId: string) {
  const [dominant] = await db.read<{ message: string; count: number }>(
    `SELECT c.message,c.entries AS count FROM backup_entry_errors c
      WHERE c.destination_id=?1 AND c.entries=
        (SELECT MAX(entries) FROM backup_entry_errors WHERE destination_id=?1)
      ORDER BY (SELECT MAX(retry_at) FROM backup_entries e
        WHERE e.destination_id=?1 AND e.last_error=c.message) DESC
      LIMIT 1`,
    [destinationId],
  );
  return dominant ?? null;
}

async function pendingPurges(db: Pick<SqliteDb, 'read'>, destinationId: string) {
  const [row] = await db.read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM backup_purges WHERE destination_id=? AND completed=0`,
    [destinationId],
  );
  return row?.n ?? 0;
}

/** Status for the Backup settings page, read from the trigger-maintained counters. */
export async function destinationStatus(
  db: Pick<SqliteDb, 'read'>,
  destination: Pick<BackupDestination, 'id' | 'kind' | 'libraryId'>,
): Promise<DestinationStatus> {
  const [status, error, purgePending] = await Promise.all([
    counts(db, destination),
    dominantError(db, destination.id),
    pendingPurges(db, destination.id),
  ]);
  const interrupted = status.prepared > 0;
  return {
    pending:
      destination.kind === 'google-drive'
        ? Math.max(0, status.live - status.covered)
        : status.pending,
    missing: status.missing,
    prepared: status.prepared,
    verified: status.verified,
    trash: status.trash,
    blocked: status.blocked + status.prepared,
    bytes: status.bytes,
    lastError: interrupted
      ? 'Interrupted local move requires recovery or retry'
      : (error?.message ?? null),
    lastErrorCount: interrupted ? status.prepared : (error?.count ?? 0),
    purgePending,
  };
}
