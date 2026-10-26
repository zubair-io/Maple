/**
 * Purging a trashed copy while another copy of the photo survives (#5403).
 *
 * The photo stays: only the trashed location goes, the asset leaves Trash,
 * and every row-only field (faces, descriptions, edits, collections) is kept.
 * No asset-wide purge intent is recorded: only the trashed location's own
 * backup entries are purged, so backups of the surviving copy stay. One an
 * earlier attempt recorded for the whole photo is retired in the same
 * transaction (`assets.trash-survivor-intent.ts`, #5419). Clearing
 * `deleted_at` dirties the remaining entries and re-arms the cloud-backup
 * stage through the `backup_asset_dirty` trigger.
 */

import {
  trashPurgeGuard,
  type TrashPurgeCandidate,
} from '../../cloud-backup/trash-purge-admission.ts';
import type { ObjectId } from '../object-id.ts';
import {
  searchBlobRearmStatements,
  searchRearmStatements,
  relocateCacheRearmStatements,
} from './assets.stage-rearm.ts';
import type { SqlStatement } from '../sqlite/protocol.ts';
import { changesAt, sqliteDb, type SqliteDb } from './db-handle.ts';
import {
  HANDED_BACK_STATEMENT,
  RECORDED_STATEMENT,
  retireWholePhotoPurgeStatements,
} from './assets.trash-survivor-intent.ts';
import { recordLocalPurgeStatements, type LocalPurgeTarget } from './local-purge.repo.ts';
import type { LocationSource } from './assets.trash.ts';

const ASSERT_CONSTRAINT = 'keep_surviving_copy';
/** The retirement statements follow the three that assert the guard. */
const RETIREMENT_AT = 3;

/** A copy outside Trash that is neither deleted nor missing, in SQL. */
const SURVIVING = `s.deleted_at IS NULL AND s.missing_since IS NULL
  AND s.path != '.maple/trash' AND substr(s.path, 1, 13) != '.maple/trash/'`;
const SURVIVOR_EXISTS = `EXISTS (SELECT 1 FROM asset_locations s WHERE s.asset_id = a.id AND ${SURVIVING})`;

/** No trash or restore move, nor any other backup lifecycle work, is prepared or leased. */
const NO_PENDING_LIFECYCLE = `NOT EXISTS (SELECT 1 FROM backup_lifecycle WHERE asset_id = a.id
  AND (phase = 'prepared' OR lease_until > unixepoch('subsec') * 1000))`;

/** Backup entries of the trashed location alone, matched by its ordinal. */
const TRASHED_ENTRY = `e.asset_id = ? AND e.state != 'purged' AND e.ordinal =
  (SELECT ordinal FROM asset_locations WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?)`;

/**
 * Ordinal 0 is the canonical location that search sorts, facets and caches
 * read. Once the trashed location is gone, if no location holds ordinal 0 —
 * the trashed copy held it, or an earlier removal left it empty — every
 * backup entry still at ordinal 0 moves to an ordinal no location or entry has
 * used (so it is never reused or paired with another copy), and the
 * lowest-ordinal surviving copy and its own entries take ordinal 0.
 */
const NEXT_FREE_ORDINAL = `(SELECT MAX(used) + 1 FROM (
  SELECT ordinal AS used FROM asset_locations WHERE asset_id = ?
  UNION ALL SELECT ordinal FROM backup_entries WHERE asset_id = ?))`;
const NO_CANONICAL_LOCATION = `NOT EXISTS (SELECT 1 FROM asset_locations WHERE asset_id = ? AND ordinal = 0)`;
const NEW_CANONICAL_ORDINAL = `(SELECT MIN(ordinal) FROM asset_locations s
  WHERE s.asset_id = ? AND ${SURVIVING})`;

/** Give the lowest-ordinal surviving copy ordinal 0 when no location holds it. */
export function canonicalOrdinalStatements(hex: string): SqlStatement[] {
  return [
    {
      sql: `UPDATE backup_entries SET ordinal = ${NEXT_FREE_ORDINAL}
             WHERE asset_id = ? AND ordinal = 0 AND ${NO_CANONICAL_LOCATION}`,
      params: [hex, hex, hex, hex],
    },
    {
      sql: `UPDATE backup_entries SET ordinal = 0
             WHERE asset_id = ? AND ordinal = ${NEW_CANONICAL_ORDINAL} AND ${NO_CANONICAL_LOCATION}`,
      params: [hex, hex, hex],
    },
    {
      sql: `UPDATE asset_locations SET ordinal = 0
             WHERE asset_id = ? AND ordinal = ${NEW_CANONICAL_ORDINAL} AND ${NO_CANONICAL_LOCATION}`,
      params: [hex, hex, hex],
    },
  ];
}

/** `erasedBackups` counts entries of other copies whose erasure an earlier
 * whole-photo purge had already started, which could not be handed back. */
export type KeepSurvivingCopyOutcome =
  | { kind: 'kept'; erasedBackups: number }
  | { kind: 'changed' };

/**
 * Drop the trashed location and take the asset out of Trash, provided the
 * Trash state still matches `expected` and a surviving copy exists.
 */
export async function keepSurvivingCopy(
  args: {
    id: ObjectId;
    trashed: LocationSource;
    expected: TrashPurgeCandidate;
    /** Clear the Apple companion paths, which the caller erases with the trashed copy. */
    dropCompanions: boolean;
    /** Files in the trashed copy's library the purge still owes the disk. */
    cleanup: readonly LocalPurgeTarget[];
  },
  dbOverride?: SqliteDb,
): Promise<KeepSurvivingCopyOutcome> {
  const db = sqliteDb(dbOverride);
  const hex = args.id.toHexString();
  const guard = trashPurgeGuard(args.expected);
  const location = [
    args.trashed.libraryId.toHexString(),
    args.trashed.path,
    args.trashed.filename,
  ] as const;
  const trashedEntryParams = [hex, hex, ...location];
  try {
    const results = await db.transaction([
      {
        sql: `CREATE TEMP TABLE keep_surviving_copy_assert(
          valid INTEGER NOT NULL CONSTRAINT ${ASSERT_CONSTRAINT} CHECK (valid = 1))`,
      },
      {
        sql: `INSERT INTO keep_surviving_copy_assert(valid) SELECT EXISTS
          (SELECT 1 FROM assets a WHERE a.id = ? ${guard.sql}
            AND EXISTS (SELECT 1 FROM asset_locations t WHERE t.asset_id = a.id
              AND t.library_id = ? AND t.path = ? AND t.filename = ?)
            AND ${SURVIVOR_EXISTS} AND ${NO_PENDING_LIFECYCLE})`,
        params: [hex, ...guard.params, ...location],
      },
      { sql: `DROP TABLE keep_surviving_copy_assert` },
      ...retireWholePhotoPurgeStatements(hex, location),
      {
        sql: `INSERT INTO backup_purges(destination_id, entry_id, record)
          SELECT e.destination_id, e.id, json_object('version', 1, 'libraryId', d.library_id,
            'entryId', e.id, 'sequence', e.sequence + 1, 'purgedAt', ?)
            FROM backup_entries e JOIN backup_destinations d ON d.id = e.destination_id
           WHERE ${TRASHED_ENTRY}
          ON CONFLICT(destination_id, entry_id) DO NOTHING`,
        params: [new Date().toISOString(), ...trashedEntryParams],
      },
      {
        sql: `UPDATE backup_entries AS e SET state = 'purged', sequence = sequence + 1, snapshot_hash = NULL
               WHERE ${TRASHED_ENTRY}`,
        params: trashedEntryParams,
      },
      {
        sql: `DELETE FROM asset_locations
               WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?`,
        params: [hex, ...location],
      },
      ...canonicalOrdinalStatements(hex),
      {
        sql: `UPDATE assets SET deleted_at = NULL, deleted_reason = NULL, original_path = NULL
               WHERE id = ?`,
        params: [hex],
      },
      ...(args.dropCompanions
        ? [
            {
              sql: `UPDATE assets SET apple_rendered_path = NULL, apple_live_video_path = NULL
                     WHERE id = ?`,
              params: [hex],
            },
          ]
        : []),
      ...recordLocalPurgeStatements(hex, location[0], args.cleanup),
      ...searchRearmStatements(hex),
      ...searchBlobRearmStatements(hex),
      ...relocateCacheRearmStatements(hex),
    ]);
    const recorded = changesAt(results, RETIREMENT_AT + RECORDED_STATEMENT);
    const handedBack = changesAt(results, RETIREMENT_AT + HANDED_BACK_STATEMENT);
    return { kind: 'kept', erasedBackups: recorded - handedBack };
  } catch (error) {
    if (error instanceof Error && error.message.includes(ASSERT_CONSTRAINT))
      return { kind: 'changed' };
    throw error;
  }
}
