/**
 * Retiring a whole-photo purge that an earlier attempt recorded, once the
 * photo turns out to have a surviving copy after all (#5419). That earlier
 * attempt marked every backup entry of the photo as purged; a kept-photo purge
 * (#5403) erases only the trashed copy's entries, so the rest are handed back.
 *
 * An entry is handed back only while its erasure provably never started: the
 * purge drain claims a row (bumps `revision`) before any destructive step, so
 * a row still at revision 0, unpublished, uncompleted, error-free and without
 * a saved purge marker has erased nothing, and deleting it in this writer
 * transaction cannot race the drain. Its backups stay and the entry is armed
 * to verify again.
 *
 * An entry whose erasure already started cannot be handed back. Its purge is
 * left to finish, and the entry is moved off its copy's ordinal once it has —
 * here when it already has, otherwise by the drain on completion (see
 * `releasedOrdinalStatements`) — so the surviving copy is backed up again as
 * a new entry rather than paired with an erased one. The row stays live
 * either way, and the caller reports how many entries were erased.
 */

import type { SqlStatement } from '../sqlite/protocol.ts';

const INTENT = 'keep_surviving_copy_intent';

/** Index, in `retireWholePhotoPurgeStatements`, of the insert counting every recorded entry. */
export const RECORDED_STATEMENT = 1;
/** Index of the delete counting the entries handed back. */
export const HANDED_BACK_STATEMENT = 3;

const UNUSED_ORDINAL_BASE = `(SELECT MAX(used) FROM (
  SELECT ordinal AS used FROM asset_locations WHERE asset_id = ?
  UNION ALL SELECT ordinal FROM backup_entries WHERE asset_id = ?))`;

/**
 * Statements to splice into the kept-photo transaction while the trashed
 * location still exists, after its guard has passed. `location` is the trashed
 * location as [libraryId, path, filename].
 */
export function retireWholePhotoPurgeStatements(
  hex: string,
  location: readonly [string, string, string],
): SqlStatement[] {
  return [
    {
      sql: `CREATE TEMP TABLE ${INTENT}(
        destination_id TEXT NOT NULL, entry_id TEXT NOT NULL, untouched INTEGER NOT NULL)`,
    },
    {
      sql: `INSERT INTO ${INTENT}(destination_id, entry_id, untouched)
        SELECT p.destination_id, p.entry_id,
          p.revision = 0 AND p.published = 0 AND p.completed = 0 AND p.last_error IS NULL
            AND NOT EXISTS (SELECT 1 FROM backup_objects o WHERE o.destination_id = p.destination_id
              AND o.key = 'purges/' || p.entry_id || '.json')
          FROM backup_purges p
          JOIN backup_entries e ON e.id = p.entry_id AND e.destination_id = p.destination_id
         WHERE e.asset_id = ?
           AND e.ordinal != (SELECT ordinal FROM asset_locations
             WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?)
           AND json_extract(p.record, '$.purgedAt') IN
             (SELECT created_at FROM backup_lifecycle WHERE asset_id = ? AND kind = 'purge')`,
      params: [hex, hex, ...location, hex],
    },
    {
      sql: `UPDATE backup_entries SET state = 'active', sequence = sequence + 1,
              snapshot_hash = NULL, retry_at = 0, attempts = 0, last_error = NULL,
              lease_owner = NULL, lease_until = 0
             WHERE id IN (SELECT entry_id FROM ${INTENT} WHERE untouched)`,
    },
    {
      sql: `DELETE FROM backup_purges WHERE (destination_id, entry_id) IN
              (SELECT destination_id, entry_id FROM ${INTENT} WHERE untouched)`,
    },
    {
      sql: `UPDATE backup_entries AS e SET ordinal = released.ordinal FROM (
              SELECT i.entry_id, ${UNUSED_ORDINAL_BASE} + ROW_NUMBER() OVER (ORDER BY i.entry_id) AS ordinal
                FROM ${INTENT} i JOIN backup_purges p
                  ON p.destination_id = i.destination_id AND p.entry_id = i.entry_id
               WHERE NOT i.untouched AND p.completed = 1) AS released
             WHERE e.id = released.entry_id`,
      params: [hex, hex],
    },
    { sql: `DELETE FROM backup_lifecycle WHERE asset_id = ? AND kind = 'purge'`, params: [hex] },
    { sql: `DROP TABLE ${INTENT}` },
  ];
}

/**
 * Run by the purge drain in the transaction that completes a purge: an erased
 * entry still sitting on the ordinal of a copy that is still indexed, of a
 * photo no longer being purged, moves to an unused ordinal, and the photo's
 * backup stage re-arms so that copy is backed up again as a new entry.
 */
export function releasedOrdinalStatements(entryId: string): SqlStatement[] {
  const held = `EXISTS (SELECT 1 FROM backup_entries e
      JOIN backup_purges p ON p.destination_id = e.destination_id AND p.entry_id = e.id
      JOIN asset_locations l ON l.asset_id = e.asset_id AND l.ordinal = e.ordinal
     WHERE e.id = ? AND e.state = 'purged' AND p.completed = 1
       AND NOT EXISTS (SELECT 1 FROM backup_lifecycle WHERE asset_id = e.asset_id AND kind = 'purge'))`;
  const asset = `(SELECT asset_id FROM backup_entries WHERE id = ?)`;
  return [
    {
      sql: `UPDATE stage_state SET version = 0, attempts = 0, dead = 0, next_attempt_at = NULL
             WHERE stage = 'cloud-backup' AND asset_id = ${asset} AND ${held}`,
      params: [entryId, entryId],
    },
    {
      sql: `UPDATE backup_entries SET ordinal = (SELECT MAX(used) + 1 FROM (
              SELECT ordinal AS used FROM asset_locations WHERE asset_id = ${asset}
              UNION ALL SELECT ordinal FROM backup_entries WHERE asset_id = ${asset}))
             WHERE id = ? AND ${held}`,
      params: [entryId, entryId, entryId, entryId],
    },
  ];
}
