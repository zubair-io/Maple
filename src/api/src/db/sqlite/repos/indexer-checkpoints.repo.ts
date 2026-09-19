/**
 * `indexer_checkpoints` — the SQLite port of the per-library indexer resume
 * point (#3751).
 *
 * One row per library root, holding where the last full walk got to and which
 * jobs were in flight when the process went down. A restart re-walks the
 * libraries whose on-disk mtime has moved past the recorded walk and
 * re-enqueues whatever the row still lists as in flight.
 *
 * ## `ensureCheckpointIndexes` has no equivalent and is not ported
 *
 * Its whole job was `createIndex({ folderId: 1 }, { unique: true })` — the
 * uniqueness the upserts depend on, which Mongo only has if somebody
 * remembers to ask for it at boot. Here `folder_id` is the primary key, so
 * that uniqueness is a property of the table rather than of a startup call
 * that could be skipped.
 *
 * ## The in-flight list is a set, and stays one
 *
 * `inflight_ids` is a JSON array column standing in for an array field, so
 * {@link markInflight} has to reproduce `$addToSet` rather than an append:
 * the marker upserts, and re-marking an id already in the list must not add a
 * second copy, or a crash-and-resume would re-enqueue the same job twice.
 * The statement tests for the id before appending and leaves the array
 * untouched when it finds one, which keeps insertion order as well as the set
 * property — a rebuild through `UNION` would dedupe but reorder.
 *
 * {@link markInflight} also upserts on `folder_id` alone, so it can create a
 * row before any walk has recorded a path. That is why `path` and
 * `last_walked_at` carry defaults in the DDL: the Mongo row simply had no such
 * fields yet, and a default is the closest honest equivalent to an absent one.
 *
 * MongoDB is still the live database; nothing imports this module yet. The
 * cutover (#3752) swaps the import paths.
 */

import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { parseJson } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

export interface CheckpointDoc {
  /** Hex string of the library folder's id. */
  folderId: string;
  /** Absolute filesystem path — handy for cross-checks / orphan cleanup. */
  path: string;
  /** Most recent time we finished a full walk (ms since epoch). */
  lastWalkedAt: number;
  /** maple:id hex strings of jobs that had been picked up but not finished. */
  inflightIds: string[];
  /** Active discover sweep generation for this folder. */
  sweepGen?: number;
  updatedAt: number;
}

interface CheckpointRow {
  folder_id: string;
  path: string;
  last_walked_at: number;
  inflight_ids: string;
  sweep_gen: number | null;
  updated_at: number;
}

/** A row as the document it replaces; an unset `sweep_gen` stays absent. */
function toDoc(row: CheckpointRow): CheckpointDoc {
  return {
    folderId: row.folder_id,
    path: row.path,
    lastWalkedAt: row.last_walked_at,
    inflightIds: parseJson<string[]>(row.inflight_ids, []),
    ...(row.sweep_gen === null ? {} : { sweepGen: row.sweep_gen }),
    updatedAt: row.updated_at,
  };
}

/** One library's checkpoint, or null when it has never been written. */
export async function readCheckpoint(
  folderId: string,
  dbOverride?: SqliteDb,
): Promise<CheckpointDoc | null> {
  const rows = await sqliteDb(dbOverride).read<CheckpointRow>(
    `SELECT folder_id, path, last_walked_at, inflight_ids, sweep_gen, updated_at
       FROM indexer_checkpoints WHERE folder_id = ?`,
    [folderId],
  );
  const row = rows[0];
  return row === undefined ? null : toDoc(row);
}

/**
 * Record a completed walk, creating the row when it does not exist.
 *
 * `updatedAt` is stamped here rather than taken from the caller's document,
 * exactly as the `$set` it replaces did — the field on the argument is
 * overwritten, so a caller that passes a stale one cannot make the row look
 * older than the write that just happened.
 *
 * `sweep_gen` is the one column an absent field must not clear. `sweepGen` is
 * optional on {@link CheckpointDoc}, and the `$set: { ...doc }` this replaces
 * simply had no such key when the caller omitted it, so whatever generation was
 * stored survived. `excluded.sweep_gen` would write NULL instead, and a NULL
 * reads back as "no sweep in progress" — which restarts the discover sweep from
 * generation 0 and re-walks the whole library. `COALESCE` restores the `$set`
 * semantics: a supplied generation overwrites, an omitted one leaves the stored
 * value alone. Clearing a generation is not something any caller asks for, and
 * an optional field cannot express the difference anyway.
 */
export async function writeCheckpoint(doc: CheckpointDoc, dbOverride?: SqliteDb): Promise<void> {
  await sqliteDb(dbOverride).write(
    `INSERT INTO indexer_checkpoints
       (folder_id, path, last_walked_at, inflight_ids, sweep_gen, updated_at)
     VALUES (?, ?, ?, json(?), ?, ?)
     ON CONFLICT (folder_id) DO UPDATE SET
       path           = excluded.path,
       last_walked_at = excluded.last_walked_at,
       inflight_ids   = excluded.inflight_ids,
       sweep_gen      = COALESCE(excluded.sweep_gen, indexer_checkpoints.sweep_gen),
       updated_at     = excluded.updated_at`,
    [
      doc.folderId,
      doc.path,
      doc.lastWalkedAt,
      JSON.stringify(doc.inflightIds),
      doc.sweepGen ?? null,
      Date.now(),
    ],
  );
}

/**
 * Add a job id to the in-flight list, creating the row when it does not exist.
 *
 * `$addToSet`: an id already in the list leaves the array exactly as it was,
 * so marking the same job twice cannot make a resume enqueue it twice. The
 * timestamp is written either way, matching the `$set` that accompanied the
 * Mongo operator.
 */
export async function markInflight(
  folderId: string,
  id: string,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `INSERT INTO indexer_checkpoints (folder_id, inflight_ids, updated_at)
     VALUES (?, json_array(?), ?)
     ON CONFLICT (folder_id) DO UPDATE SET
       inflight_ids = CASE
         WHEN EXISTS (
           SELECT 1 FROM json_each(indexer_checkpoints.inflight_ids) WHERE value = ?
         ) THEN indexer_checkpoints.inflight_ids
         ELSE json_insert(indexer_checkpoints.inflight_ids, '$[#]', ?)
       END,
       updated_at = excluded.updated_at`,
    [folderId, id, Date.now(), id, id],
  );
}

/**
 * Remove a job id from the in-flight list.
 *
 * `$pull`: every occurrence goes, and a row that does not exist is left alone
 * — the Mongo version carried no `upsert`, because there is nothing to record
 * about a job finishing on a library that was never checkpointed.
 */
export async function clearInflight(
  folderId: string,
  id: string,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `UPDATE indexer_checkpoints
        SET inflight_ids = (
              SELECT json_group_array(value)
                FROM json_each(indexer_checkpoints.inflight_ids)
               WHERE value <> ?
            ),
            updated_at = ?
      WHERE folder_id = ?`,
    [id, Date.now(), folderId],
  );
}
