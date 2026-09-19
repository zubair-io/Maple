/**
 * Every statement the ported imports repository runs, in one place.
 *
 * Separated from the functions that call it for the reason `assets.sql.ts`
 * gives: the shape of a couple of these queries *is* the correctness argument,
 * and a reviewer should be able to read them together rather than stepping
 * through TypeScript. Two shapes here are load-bearing.
 *
 * **The claimable predicate is written once.** {@link CLAIMABLE_PREDICATE}
 * appears in the candidate query and again in the compare-and-swap that decides
 * the winner. If those two drifted, a worker could claim an import the
 * candidate query never considered claimable, which is the failure Mongo's
 * `findOneAndUpdate` made impossible by construction.
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
  error, locked_by, lease_expires_at, cancel_requested, created_at, updated_at`;

/** The number of `?` an insert of a whole import row binds. */
const IMPORT_COLUMN_COUNT = 17;

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
 * Free or lease-expired: a `pending` import nobody holds, or a `running` one
 * whose holder's lease ran out mid-copy.
 *
 * `lease_expires_at < ?` never matches a NULL lease, in SQLite and in MongoDB
 * alike — Mongo's range operators are type-bracketed, so `{ $lt: <string> }`
 * skips null — which is what keeps a `running` import that never recorded a
 * lease from being reclaimed by either engine.
 */
const CLAIMABLE_PREDICATE = `(
  (status = 'pending' AND locked_by IS NULL)
  OR (status = 'running' AND lease_expires_at < ?)
)`;

export const CLAIM_CANDIDATES_SQL = `
  SELECT id FROM imports WHERE ${CLAIMABLE_PREDICATE} ORDER BY created_at, id LIMIT 8`;

export const CLAIM_IMPORT_SQL = `
  UPDATE imports
     SET status = 'running', locked_by = ?, lease_expires_at = ?, updated_at = ?
   WHERE id = ? AND ${CLAIMABLE_PREDICATE}`;

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
export function insertFileStatements(importId: string, files: ImportFileEntry[]): SqlStatement[] {
  return Array.from({ length: Math.ceil(files.length / INSERT_BATCH) }, (_unused, batch) => {
    const start = batch * INSERT_BATCH;
    const slice = files.slice(start, start + INSERT_BATCH);
    return {
      sql: `INSERT INTO import_files
              (import_id, idx, src, dest, size, mtime, kind, state, error)
            VALUES ${fileValues(slice.length)}`,
      params: slice.flatMap((file, offset) => importFileParams(importId, file, start + offset)),
    };
  });
}
