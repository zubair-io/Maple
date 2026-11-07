import type { Database } from 'bun:sqlite';
import { assembleStatus, type DestinationStatus, type StatusCounts } from './destination-status.ts';
import type { BackupDestination } from './repository.ts';

/**
 * The aggregates `GET /api/cloud-backup/destinations` recomputed on every
 * request before #5707, kept verbatim as the reference the counters must
 * match. `?1` is the destination id, `?2` its library id.
 */
export const LEGACY_STATUS_SQL = {
  entries: `SELECT COALESCE(SUM(CASE WHEN state!='purged' AND verified_sequence<sequence THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN state!='purged' AND verified_sequence=sequence THEN 1 ELSE 0 END),0) AS verified,
      COALESCE(SUM(CASE WHEN state='trash' THEN 1 ELSE 0 END),0) AS trash,
      COALESCE(SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END),0) AS blocked,
      COALESCE(SUM((SELECT SUM(json_extract(value,'$.object.size')) FROM json_each(manifest,'$.files'))),0) AS bytes
      FROM backup_entries WHERE destination_id=?1`,
  coverage: `SELECT COALESCE((SELECT live_locations FROM backup_coverage_counts WHERE library_id=?2),0) AS live,
      (SELECT COUNT(*) FROM backup_entries e
        JOIN asset_locations l ON l.asset_id=e.asset_id AND l.ordinal=e.ordinal
        JOIN assets a ON a.id=e.asset_id
        WHERE e.destination_id=?1 AND l.library_id=?2 AND l.deleted_at IS NULL
          AND l.missing_since IS NULL AND a.deleted_reason IS NULL
          AND (e.state='purged' OR e.verified_sequence>=e.sequence)) AS covered`,
  missing: `SELECT (SELECT COUNT(*) FROM asset_locations
      WHERE library_id=?2 AND missing_since IS NOT NULL)
      + (SELECT COUNT(*) FROM assets AS a INDEXED BY assets_reaped
        JOIN asset_locations l ON l.asset_id=a.id
        WHERE a.deleted_reason='reaped' AND l.library_id=?2 AND l.missing_since IS NULL) AS missing,
    (SELECT COUNT(*) FROM backup_lifecycle WHERE library_id=?2 AND phase='prepared') AS prepared`,
  error: `SELECT last_error AS message,COUNT(*) AS count FROM backup_entries
      WHERE destination_id=?1 AND last_error IS NOT NULL
      GROUP BY last_error ORDER BY count DESC,MAX(retry_at) DESC LIMIT 1`,
  purges: `SELECT completed FROM backup_purges WHERE destination_id=?1`,
} as const;

type Target = Pick<BackupDestination, 'id' | 'kind' | 'libraryId'>;

/** Bindings for one legacy statement; SQLite rejects values for parameters a statement lacks. */
export function legacyParams(sql: string, destination: Target): string[] {
  return sql.includes('?2') ? [destination.id, destination.libraryId] : [destination.id];
}

function legacyRow<T>(db: Database, sql: string, destination: Target): T {
  return db.query(sql).get(...legacyParams(sql, destination)) as T;
}

/** The status as the pre-#5707 aggregates report it. */
export function recountedStatus(db: Database, destination: Target): DestinationStatus {
  const counts: StatusCounts = {
    ...legacyRow<Omit<StatusCounts, 'live' | 'covered' | 'missing' | 'prepared'>>(
      db,
      LEGACY_STATUS_SQL.entries,
      destination,
    ),
    ...legacyRow<{ live: number; covered: number }>(db, LEGACY_STATUS_SQL.coverage, destination),
    ...legacyRow<{ missing: number; prepared: number }>(db, LEGACY_STATUS_SQL.missing, destination),
  };
  const purges = db.query(LEGACY_STATUS_SQL.purges).all(destination.id) as Array<{
    completed: number;
  }>;
  return assembleStatus(
    destination.kind,
    counts,
    legacyRow<{ message: string; count: number } | null>(db, LEGACY_STATUS_SQL.error, destination),
    purges.filter((purge) => !purge.completed).length,
  );
}

/** The legacy covered count, before Drive's pending clamps it at zero and could hide an overcount. */
export function recountedCovered(db: Database, destination: Target): number {
  return legacyRow<{ covered: number }>(db, LEGACY_STATUS_SQL.coverage, destination).covered;
}
