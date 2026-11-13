/**
 * Imports repository — the SQLite port of `imports/repo.ts` (#3751).
 *
 * Every function the Mongo repo exports has an equivalent here with the same
 * name, the same parameters and the same return type, so the cutover (#3752)
 * changes the import path in `routes/imports.ts` and `imports/worker.ts` and
 * nothing else. The one addition is the optional trailing `dbOverride`, which
 * accepts a SQLite handle; no route passes it, it is the tests' seam.
 *
 * The compatibility entry point `imports/repo.ts` now re-exports this live
 * SQLite repository; import routes and the import worker use it (#3752).
 *
 * ## Layout
 *
 *   - `imports.sql.ts`    every statement, and the held-import predicate
 *   - `imports.rows.ts`   row shapes and row → document conversions
 *   - `imports.repo.ts`   the verbs the routes and the worker call (this file)
 *   - `imports.retry.ts`  the one accessor with real branching
 *
 * ## The `imports` row is the work queue
 *
 * The row is the record and the queue; Temporal is the schedule. A route
 * inserts or resets a `pending` row, the worker tier relays the oldest one to a
 * workflow ({@link nextImportId}, {@link markImportDispatched}) once nothing
 * else is held, and that workflow's activity calls {@link claimImport} for
 * exactly that row. Temporal's heartbeat timeout decides when an attempt is
 * gone; `locked_by` only fences a superseded attempt's writes.
 *
 * ## Three places this is stricter than the Mongo original
 *
 *  - **Creating an import is atomic.** The Mongo version inserts the import,
 *    then inserts the file rows, then hand-rolls a compensating delete of both
 *    if the second step throws — a rollback that can itself fail and leave a
 *    `pending` import whose `progress.total` promises rows that are not there.
 *    Here the import row and every file row are one transaction.
 *  - **Re-filling an Auto Import's files is atomic.** Same argument:
 *    {@link setImportFiles} deletes the previous scan's rows, inserts the new
 *    ones and updates the import in one transaction, so no reader can observe
 *    the window where the old rows are gone and the new ones have not landed.
 *  - **Duplicate file positions cannot be half-written.** `(import_id, idx)`
 *    is UNIQUE, and a conflicting insert aborts the transaction rather than
 *    being swallowed per-document the way `insertMany({ ordered: false })`
 *    swallows it.
 *
 * ## One behaviour deliberately dropped
 *
 * `getImportFiles` on Mongo falls back to the legacy inline `ImportDoc.files`
 * array and hydrates the `import_files` collection from it on first read. The
 * table has no `files` column — the Mongo-to-SQLite data import writes legacy
 * entries out as rows — so the fallback has nothing to read and no reason to
 * exist. {@link getImportFiles} is the collection query alone.
 */

import type { ObjectId } from '../object-id.ts';
import type { SqlValue } from '../sqlite/protocol.ts';
import type { ImportFileEntry, ImportFileState, ImportStatus, ImportWithId } from '../schema.ts';
import { newObjectIdHex } from '../object-id.ts';
import { changesAt, sqliteDb, type SqliteDb } from './db-handle.ts';
import {
  toClaimedImport,
  toImportDoc,
  toImportFileEntry,
  type ClaimedImport,
  type ImportFileEntryWithIdx,
  type ImportFileRow,
  type ImportRow,
} from './imports.rows.ts';
import {
  CLAIM_PENDING_IMPORT_SQL,
  heldBy,
  HELD_IMPORTS_SQL,
  IMPORT_BY_ID_SQL,
  IMPORT_FILES_SQL,
  INSERT_IMPORT_SQL,
  insertFileStatements,
  listImportsSql,
  MARK_IMPORT_DISPATCHED_SQL,
  NEXT_IMPORT_SQL,
  TAKE_OVER_IMPORT_SQL,
} from './imports.sql.ts';
import { DISPATCHED_MARKER } from './jobs.sql.ts';
import { toHex } from './values.ts';

export type { SqliteDb } from './db-handle.ts';
export type { ClaimedImport, ImportFileEntryWithIdx } from './imports.rows.ts';

export interface CreateImportInput {
  source_root: string;
  library_id: ObjectId;
  library_root: string;
  files: ImportFileEntry[];
  /** Auto Import — worker scans `source_root` to fill `files`. Default false. */
  scan_pending?: boolean;
}

export interface ListImportsFilter {
  status?: ImportStatus;
  limit?: number;
}

/** The per-file tallies an import carries and every terminal transition writes. */
type ImportCounts = { copied: number; skipped: number; failed: number };

/** One import row, or `null`. */
async function readImportRow(db: SqliteDb, hex: string): Promise<ImportRow | null> {
  const rows = await db.read<ImportRow>(IMPORT_BY_ID_SQL, [hex]);
  return rows[0] ?? null;
}

/**
 * Insert a pending import together with its per-file rows.
 *
 * `progress.total` is the file count. The entries are rows in `import_files`
 * rather than an array on the import row, which is the split that made a
 * hundred-thousand-file folder importable at all; rows have no per-document
 * size ceiling, so the split simply stays.
 *
 * The whole thing is one transaction, which retires the Mongo version's
 * compensating delete: there is no longer a moment at which a `pending` import
 * exists whose `progress.total` counts rows that were never written.
 */
export async function createImport(
  input: CreateImportInput,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<ImportWithId> {
  const db = sqliteDb(dbOverride);
  const id = newObjectIdHex();
  const nowIso = now().toISOString();
  const row: ImportRow = {
    id,
    status: 'pending',
    source_root: input.source_root,
    library_id: toHex(input.library_id),
    library_root: input.library_root,
    scan_pending: input.scan_pending === true ? 1 : 0,
    progress_current: 0,
    progress_total: input.files.length,
    count_copied: 0,
    count_skipped: 0,
    count_failed: 0,
    error: null,
    locked_by: null,
    cancel_requested: 0,
    created_at: nowIso,
    updated_at: nowIso,
  };

  await db.transaction([
    {
      sql: INSERT_IMPORT_SQL,
      params: [
        row.id,
        row.status,
        row.source_root,
        row.library_id,
        row.library_root,
        row.scan_pending,
        row.progress_current,
        row.progress_total,
        row.count_copied,
        row.count_skipped,
        row.count_failed,
        row.error,
        row.locked_by,
        row.cancel_requested,
        row.created_at,
        row.updated_at,
      ],
    },
    ...insertFileStatements(id, input.files),
  ]);

  return toImportDoc(row);
}

export async function getImport(id: ObjectId, dbOverride?: SqliteDb): Promise<ImportWithId | null> {
  const row = await readImportRow(sqliteDb(dbOverride), toHex(id));
  return row === null ? null : toImportDoc(row);
}

/** List imports filtered by status, newest first. Hard-capped at 200. */
export async function listImports(
  filter: ListImportsFilter,
  dbOverride?: SqliteDb,
): Promise<ImportWithId[]> {
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
  const scoped = filter.status !== undefined;
  const rows = await sqliteDb(dbOverride).read<ImportRow>(
    listImportsSql(scoped),
    scoped ? [filter.status as string, limit] : [limit],
  );
  return rows.map(toImportDoc);
}

/** Raised by an attempt's write once the import is no longer its to write. */
export class ImportTakenOver extends Error {
  override name = 'ImportTakenOver';
  constructor() {
    super('This attempt no longer holds the import');
  }
}

async function holdsImport(db: SqliteDb, hex: string, holder: string): Promise<boolean> {
  const rows = await db.read<{ locked_by: string | null; status: string }>(
    `SELECT locked_by, status FROM imports WHERE id = ?`,
    [hex],
  );
  return rows[0]?.locked_by === holder && rows[0].status === 'running';
}

/**
 * Claim the import Temporal just delivered, for one activity attempt. `null`
 * when the import has already finished or does not exist.
 */
export async function claimImport(
  id: ObjectId,
  workerId: string,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<ClaimedImport | null> {
  const db = sqliteDb(dbOverride);
  const hex = toHex(id);
  const params = [workerId, now().toISOString(), hex];
  const results = await db.transaction([
    { sql: TAKE_OVER_IMPORT_SQL, params },
    { sql: CLAIM_PENDING_IMPORT_SQL, params },
  ]);
  const takenOver = changesAt(results, 0) === 1;
  if (!takenOver && changesAt(results, 1) !== 1) return null;
  const row = await readImportRow(db, hex);
  return row === null ? null : toClaimedImport(row, takenOver);
}

export async function nextImportId(dbOverride?: SqliteDb): Promise<string | null> {
  const rows = await sqliteDb(dbOverride).read<{ id: string }>(NEXT_IMPORT_SQL, []);
  return rows[0]?.id ?? null;
}

export async function heldImportIds(dbOverride?: SqliteDb): Promise<string[]> {
  const rows = await sqliteDb(dbOverride).read<{ id: string }>(HELD_IMPORTS_SQL, []);
  return rows.map((row) => row.id);
}

export async function markImportDispatched(id: string, dbOverride?: SqliteDb): Promise<void> {
  await sqliteDb(dbOverride).write(MARK_IMPORT_DISPATCHED_SQL, [DISPATCHED_MARKER, id]);
}

/**
 * Settle an import whose workflow was stopped in Temporal. Copied files stay
 * where they landed; only a pending or running import moves.
 */
export async function cancelUnfinishedImport(
  id: ObjectId,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `UPDATE imports SET status = 'cancelled', cancel_requested = 1,
            locked_by = NULL, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'running')`,
    [now().toISOString(), toHex(id)],
  );
}

/**
 * Load an import's per-file entries in stable `idx` order.
 *
 * The Mongo version also carries a fallback for imports written before the
 * entries were split out of the import document, hydrating the collection from
 * the inline array on first read. There is no inline array to read here — the
 * table has no `files` column and the data import writes those legacy entries
 * out as rows — so the fallback is gone rather than ported.
 */
export async function getImportFiles(
  id: ObjectId,
  dbOverride?: SqliteDb,
): Promise<ImportFileEntryWithIdx[]> {
  const rows = await sqliteDb(dbOverride).read<ImportFileRow>(IMPORT_FILES_SQL, [toHex(id)]);
  return rows.map(toImportFileEntry);
}

/**
 * Populate an Auto Import's files after the worker's deferred scan: replace
 * any rows a prior scan left behind, set `progress.total` and clear
 * `scan_pending`.
 *
 * `progress.current` goes back to zero with them. A re-scan replaces the file
 * rows wholesale, so the previous attempt's per-file counter no longer refers
 * to anything; leaving it would report a completion rate against the NEW total
 * that this run has not earned, and above 100% when the re-scan finds fewer
 * files.
 *
 * One transaction, so the delete and the inserts cannot be observed apart.
 * With `holder`, every statement is fenced to that attempt and a miss throws
 * {@link ImportTakenOver}.
 */
export async function setImportFiles(
  id: ObjectId,
  files: ImportFileEntry[],
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
  holder?: string,
): Promise<void> {
  const hex = toHex(id);
  const fence = heldBy(hex, holder);
  const results = await sqliteDb(dbOverride).transaction([
    {
      sql: `DELETE FROM import_files WHERE import_id = ?${fence.sql}`,
      params: [hex, ...fence.params],
    },
    ...insertFileStatements(hex, files, holder),
    {
      sql: `UPDATE imports
               SET scan_pending = 0, progress_total = ?, progress_current = 0, updated_at = ?
             WHERE id = ?${fence.sql}`,
      params: [files.length, now().toISOString(), hex, ...fence.params],
    },
  ]);
  if (holder !== undefined && changesAt(results, results.length - 1) !== 1) {
    throw new ImportTakenOver();
  }
}

/**
 * Persist one file's outcome. `index` is the file's `idx`;
 * `current` is the count processed so far. Counts are recomputed by the caller
 * and written wholesale so a redelivered attempt cannot double-count.
 *
 * Both writes are one transaction, and the import-level update carries the
 * file row's existence in its own `WHERE`. That is what makes the throw below
 * safe to raise after the commit: when the file row is missing, the guard is
 * false, neither statement changed anything, and the import's counters have not
 * advanced against per-file state that did not move. The worker turns the throw
 * into a failed import and a retry re-runs the file deterministically.
 *
 * `holder` fences both writes to one attempt; once a later attempt has taken
 * the import over, nothing is written and {@link ImportTakenOver} is thrown.
 */
export async function updateImportProgress(
  id: ObjectId,
  args: {
    index: number;
    state: ImportFileState;
    error: string | null;
    destRel: string;
    current: number;
    counts: ImportCounts;
    holder?: string;
  },
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<void> {
  const hex = toHex(id);
  const db = sqliteDb(dbOverride);
  const fence = heldBy(hex, args.holder);
  const results = await db.transaction([
    {
      sql: `UPDATE import_files SET state = ?, error = ?, dest = ?
             WHERE import_id = ? AND idx = ?${fence.sql}`,
      params: [args.state, args.error, args.destRel, hex, args.index, ...fence.params],
    },
    {
      sql: `UPDATE imports
               SET progress_current = ?, count_copied = ?, count_skipped = ?, count_failed = ?,
                   updated_at = ?
             WHERE id = ?
               AND EXISTS (SELECT 1 FROM import_files WHERE import_id = ? AND idx = ?)${fence.sql}`,
      params: [
        args.current,
        args.counts.copied,
        args.counts.skipped,
        args.counts.failed,
        now().toISOString(),
        hex,
        hex,
        args.index,
        ...fence.params,
      ],
    },
  ]);
  if (changesAt(results, 0) !== 1) {
    if (args.holder !== undefined && !(await holdsImport(db, hex, args.holder))) {
      throw new ImportTakenOver();
    }
    throw new Error(
      `updateImportProgress: no import_files row for import ${hex} idx ${args.index}`,
    );
  }
}

/**
 * The three terminal transitions differ only in status and payload. Only an
 * unfinished import moves: an attempt still copying after its workflow was
 * terminated must not overwrite the cancel that termination recorded, and with
 * `holder` an attempt a later one replaced must not finish that one's import.
 */
async function finishImport(
  db: SqliteDb,
  hex: string,
  assignments: string,
  params: SqlValue[],
  nowIso: string,
  holder: string | undefined,
): Promise<void> {
  const fence = heldBy(hex, holder);
  await db.write(
    `UPDATE imports SET ${assignments}, locked_by = NULL, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'running')${fence.sql}`,
    [...params, nowIso, hex, ...fence.params],
  );
}

/**
 * `done` and `cancelled` are the same write down to the counters: both land the
 * tallies the worker finished with, and they differ only in the status and in
 * what happens to a previous attempt's error text. A completed import has none
 * by definition, so `done` clears it; a cancelled import keeps whatever the
 * worker last recorded, because the operator may well want to read it.
 */
async function finishWithCounts(
  status: 'done' | 'cancelled',
  id: ObjectId,
  counts: ImportCounts,
  now: () => Date,
  dbOverride: SqliteDb | undefined,
  holder: string | undefined,
): Promise<void> {
  const clearError = status === 'done' ? `, error = NULL` : '';
  await finishImport(
    sqliteDb(dbOverride),
    toHex(id),
    `status = '${status}', count_copied = ?, count_skipped = ?, count_failed = ?${clearError}`,
    [counts.copied, counts.skipped, counts.failed],
    now().toISOString(),
    holder,
  );
}

export async function completeImport(
  id: ObjectId,
  counts: ImportCounts,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
  holder?: string,
): Promise<void> {
  await finishWithCounts('done', id, counts, now, dbOverride, holder);
}

export async function failImport(
  id: ObjectId,
  error: string,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
  holder?: string,
): Promise<void> {
  await finishImport(
    sqliteDb(dbOverride),
    toHex(id),
    `status = 'failed', error = ?`,
    [error],
    now().toISOString(),
    holder,
  );
}

export async function markImportCancelled(
  id: ObjectId,
  counts: ImportCounts,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
  holder?: string,
): Promise<void> {
  await finishWithCounts('cancelled', id, counts, now, dbOverride, holder);
}

/**
 * Flip `cancel_requested`. The worker observes it between files. Returns true
 * if the import exists and is still cancellable (pending or running).
 */
export async function requestImportCancel(
  id: ObjectId,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const result = await sqliteDb(dbOverride).write(
    `UPDATE imports SET cancel_requested = 1, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'running')`,
    [now().toISOString(), toHex(id)],
  );
  return result.changes > 0;
}

export async function isImportCancelRequested(
  id: ObjectId,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const rows = await sqliteDb(dbOverride).read<{ cancel_requested: number }>(
    `SELECT cancel_requested FROM imports WHERE id = ?`,
    [toHex(id)],
  );
  return rows[0]?.cancel_requested === 1;
}

/**
 * Content-dedup against `assets` — the same keys the discover watcher uses.
 * True when an asset already exists with this `maple_id` or `sha1_head`,
 * meaning the image is already in the library and the import should skip it.
 *
 * One statement rather than the Mongo version's two sequential `findOne`s. SQL
 * `OR` short-circuits, so the `sha1_head` probe still only runs when the
 * `maple_id` probe misses, and the whole thing costs one round trip per file
 * instead of up to two — this is called once per file in an import, so the
 * saving is per-file rather than per-import.
 *
 * Each sub-select repeats its index's partial `WHERE` (`maple_id IS NOT NULL
 * AND maple_id <> ''`, `sha1_head IS NOT NULL`). SQLite only uses a partial
 * index when the query's own predicate textually implies the index's, and a
 * bound `= ?` does not prove the column is non-empty.
 *
 * That repetition also changes one answer, deliberately. An empty `maple_id`
 * used to match any other asset whose `maple_id` was empty, because Mongo's
 * `findOne({ maple_id })` compared the two empty strings and found them equal —
 * so a file whose hash came back empty was reported as already in the library
 * and skipped, and so was every later one. An empty hash is the absence of an
 * identity rather than an identity everything shares, so it now matches
 * nothing and the file is imported. `sha1_head` needs no equivalent: it is
 * `NULL` when absent, and `NULL = NULL` was never true on either side.
 */
export async function assetExistsForHash(
  maple_id: string,
  sha1_head: string,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const rows = await sqliteDb(dbOverride).read<{ present: number }>(
    `SELECT
       (EXISTS (SELECT 1 FROM assets
                 WHERE maple_id = ? AND maple_id IS NOT NULL AND maple_id <> '')
        OR EXISTS (SELECT 1 FROM assets
                    WHERE sha1_head = ? AND sha1_head IS NOT NULL)) AS present`,
    [maple_id, sha1_head],
  );
  return rows[0]?.present === 1;
}
