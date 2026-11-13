/**
 * Every statement the ported imports repository runs, in one place.
 *
 * Separated from the functions that call it for the reason `assets.sql.ts`
 * gives: the shape of a couple of these queries *is* the correctness argument,
 * and a reviewer should be able to read them together rather than stepping
 * through TypeScript. Two shapes here are load-bearing.
 *
 * **One import is held at a time.** {@link NEXT_IMPORT_SQL} only offers the
 * oldest waiting import once no other is held, and {@link HELD_IMPORTS_SQL}
 * names the held ones with the same predicate, so the relay and the
 * reconciliation that checks on it cannot disagree about which rows Temporal
 * holds.
 *
 * **The file inserts are batched but not chunked across transactions.** An
 * import's rows all land in one transaction, so a batch is about the parameter
 * ceiling rather than about durability; see {@link insertFileStatements}.
 */

import type { SqlStatement } from '../sqlite/protocol.ts';
import type { ImportFileEntry } from '../schema.ts';
import { importFileParams } from './imports.rows.ts';
import { placeholders } from './values.ts';

/** Every `imports` column, in declaration order. */
const IMPORT_COLUMNS = `
  id, status, source_root, library_id, library_root, scan_pending,
  progress_current, progress_total, count_copied, count_skipped, count_failed,
  error, locked_by, cancel_requested, created_at, updated_at`;

/** The number of `?` an insert of a whole import row binds. */
const IMPORT_COLUMN_COUNT = 16;

export const IMPORT_BY_ID_SQL = `SELECT ${IMPORT_COLUMNS} FROM imports WHERE id = ?`;

export const INSERT_IMPORT_SQL = `
  INSERT INTO imports (${IMPORT_COLUMNS}) VALUES (${placeholders(IMPORT_COLUMN_COUNT)})`;

export const IMPORT_FILES_SQL = `
  SELECT idx, src, dest, size, mtime, kind, state, error
    FROM import_files WHERE import_id = ? ORDER BY idx`;

/**
 * The imports list, newest first, optionally narrowed to one status.
 *
 * Two statement texts rather than one with an `(? IS NULL OR status = ?)`
 * residual: the residual form defeats the `imports_list` index, because the
 * planner cannot know at prepare time whether the status is bound.
 */
export function listImportsSql(scoped: boolean): string {
  return `SELECT ${IMPORT_COLUMNS} FROM imports
          ${scoped ? 'WHERE status = ?' : ''}
          ORDER BY created_at DESC LIMIT ?`;
}

/**
 * An import Temporal holds: running, or pending with its workflow already
 * started. At most one exists at a time, because {@link NEXT_IMPORT_SQL} waits
 * for it.
 */
const HELD = `(status = 'running' OR (status = 'pending' AND locked_by IS NOT NULL))`;

/**
 * The oldest pending import, but only once nothing else is held.
 *
 * Handing Temporal one import at a time is what keeps imports in the order they
 * were created. `locked_by IS NULL` separates a fresh or retried import from a
 * held one; every statement that puts an import back into `pending` clears it.
 */
export const NEXT_IMPORT_SQL = `
  SELECT id FROM imports
   WHERE status = 'pending' AND locked_by IS NULL
     AND NOT EXISTS (SELECT 1 FROM imports WHERE ${HELD})
   ORDER BY created_at, id LIMIT 1`;

export const HELD_IMPORTS_SQL = `SELECT id FROM imports WHERE ${HELD} ORDER BY created_at, id`;

/** Guarded so an import its activity has already claimed keeps that claim. */
export const MARK_IMPORT_DISPATCHED_SQL = `
  UPDATE imports SET locked_by = ? WHERE id = ? AND status = 'pending' AND locked_by IS NULL`;

/**
 * Hand one import to the activity attempt Temporal just delivered.
 *
 * A `running` row is taken over, not skipped: Temporal delivers another attempt
 * once the previous one missed its heartbeat deadline or was reset, and the
 * holder named in `locked_by` may still be running. Whatever it still tries to
 * write is refused by {@link heldBy}. A finished import matches nothing, which
 * is how a redelivery becomes a no-op.
 */
export const CLAIM_IMPORT_SQL = `
  UPDATE imports
     SET status = 'running', locked_by = ?, updated_at = ?
   WHERE id = ? AND status IN ('pending', 'running')`;

const HELD_BY_SQL = `EXISTS (SELECT 1 FROM imports WHERE id = ? AND locked_by = ? AND status = 'running')`;

export interface AttemptFence {
  sql: string;
  params: string[];
}

/**
 * The fence on a write made by one activity attempt: it lands only while that
 * attempt still holds the running import. Empty for a write made outside an
 * attempt.
 */
export function heldBy(importId: string, holder: string | undefined): AttemptFence {
  return holder === undefined
    ? { sql: '', params: [] }
    : { sql: ` AND ${HELD_BY_SQL}`, params: [importId, holder] };
}

export const IMPORT_PUBLISHING_DESTS_SQL = `
  SELECT idx, publishing_dest FROM import_files
   WHERE import_id = ? AND publishing_dest IS NOT NULL ORDER BY idx`;

/**
 * Sets one file's publish marker, or clears it with `null`, for the attempt
 * that holds the import. It is its own statement and not part of the file's
 * outcome: the marker has to be committed before the file is published, and the
 * outcome is only known afterwards.
 */
export function publishingDestStatement(
  importId: string,
  index: number,
  destRel: string | null,
  holder: string,
): SqlStatement {
  const fence = heldBy(importId, holder);
  return {
    sql: `UPDATE import_files SET publishing_dest = ?
           WHERE import_id = ? AND idx = ?${fence.sql}`,
    params: [destRel, importId, index, ...fence.params],
  };
}

/**
 * Rows per bulk-insert statement.
 *
 * Nine bound values per row against SQLite's 32,766-parameter ceiling leaves
 * ample headroom at this size, and the statement text is then one of a handful
 * the worker keeps prepared rather than a fresh one per import.
 */
const INSERT_BATCH = 1_000;

/** `(?, …), (?, …)` tuples for `count` rows of nine columns each. */
function fileValues(count: number): string {
  return Array.from({ length: count }, () => `(${placeholders(9)})`).join(', ');
}

/**
 * The statements that write `files` as `import_files` rows for `importId`,
 * numbered by position. Empty for an empty list.
 */
export function insertFileStatements(
  importId: string,
  files: ImportFileEntry[],
  holder?: string,
): SqlStatement[] {
  const fence = heldBy(importId, holder);
  return Array.from({ length: Math.ceil(files.length / INSERT_BATCH) }, (_unused, batch) => {
    const start = batch * INSERT_BATCH;
    const slice = files.slice(start, start + INSERT_BATCH);
    const rows = `VALUES ${fileValues(slice.length)}`;
    return {
      sql: `INSERT INTO import_files
              (import_id, idx, src, dest, size, mtime, kind, state, error)
            ${holder === undefined ? rows : `SELECT * FROM (${rows}) WHERE TRUE${fence.sql}`}`,
      params: [
        ...slice.flatMap((file, offset) => importFileParams(importId, file, start + offset)),
        ...fence.params,
      ],
    };
  });
}
