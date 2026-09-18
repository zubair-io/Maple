/**
 * Imports repository — the SQLite port of `imports/repo.ts` (#3751).
 *
 * Every function the Mongo repo exports has an equivalent here with the same
 * name, the same parameters and the same return type, so the cutover (#3752)
 * changes the import path in `routes/imports.ts` and `imports/worker.ts` and
 * nothing else. The one addition is the optional trailing `dbOverride`, which
 * accepts a SQLite handle; no route passes it, it is the tests' seam.
 *
 * MongoDB is still the live database and the Mongo repo is untouched. This is
 * the same staged shape #3746 landed the assets port in: build the replacement
 * beside the original, prove it, then switch the imports in one commit.
 *
 * ## Layout
 *
 *   - `imports.sql.ts`    every statement, and the claim's shared predicate
 *   - `imports.rows.ts`   row shapes and row → document conversions
 *   - `imports.repo.ts`   the verbs the routes and the worker call (this file)
 *   - `imports.retry.ts`  the one accessor with real branching
 *
 * ## The `imports` row is the work queue
 *
 * Claim and lease live on the row, exactly as they did on the document, and
 * {@link claimImport} is the one place that needs care. A Mongo
 * `findOneAndUpdate` with a sort is a compare-and-swap that only one caller can
 * win; SQLite's pool has no primitive that both writes and returns rows, so the
 * same guarantee is obtained by re-checking the claimable predicate in the
 * `UPDATE`'s own `WHERE` and reading the row count. See {@link claimImport}.
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

import type { ObjectId } from 'mongodb';
import type { SqlValue } from '../protocol.ts';
import type { ImportFileEntry, ImportFileState, ImportStatus, ImportWithId } from '../../schema.ts';
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
  CLAIM_CANDIDATES_SQL,
  CLAIM_IMPORT_SQL,
  IMPORT_BY_ID_SQL,
  IMPORT_FILES_SQL,
  INSERT_IMPORT_SQL,
  insertFileStatements,
  listImportsSql,
} from './imports.sql.ts';
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
 * The three values every lease-renewing write needs together: the import's hex
 * id, the instant of the write, and the instant the renewed claim lapses.
 *
 * Derived from one reading of the clock on purpose. Stamping `updated_at` from
 * one reading and `lease_expires_at` from another would make the lease shorter
 * or longer than `leaseMs` by however long the statements took to build, which
 * is the kind of drift that only shows up as a rare mid-copy reclaim.
 */
function leaseStamps(
  id: ObjectId,
  leaseMs: number,
  now: () => Date,
): { hex: string; nowIso: string; leaseExpiresAt: string } {
  const at = now();
  return {
    hex: toHex(id),
    nowIso: at.toISOString(),
    leaseExpiresAt: new Date(at.getTime() + leaseMs).toISOString(),
  };
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
    lease_expires_at: null,
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
        row.lease_expires_at,
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

/**
 * Atomic claim: a `pending` import with no lock, or a `running` one whose
 * lease expired because the previous worker died mid-copy.
 *
 * The exclusivity comes from the `UPDATE`'s own `WHERE`, not from the read
 * above it. Mongo gets this from `findOneAndUpdate`, which matches and writes
 * in one server-side step; the SQLite pool has no primitive that writes and
 * returns rows, so the candidate ids are read first and then each one is
 * claimed with the claimable predicate repeated in the `WHERE`. A row count of
 * one means this caller won it. A row count of zero means a sibling runner took
 * it in between, and the next candidate is tried — which is why the read asks
 * for several rather than one.
 *
 * Exclusivity is PER IMPORT, not global, exactly as it was on Mongo: only one
 * runner ever processes a given import, but two *different* pending imports may
 * run concurrently. That is safe by construction — copies are no-clobber
 * (`imports/copy.ts`) and per-file dedup is an atomic lookup — so concurrent
 * imports into the same library never lose a file.
 */
export async function claimImport(
  workerId: string,
  leaseMs: number,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<ClaimedImport | null> {
  const db = sqliteDb(dbOverride);
  const nowDate = now();
  const nowIso = nowDate.toISOString();
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();

  const candidates = await db.read<{ id: string }>(CLAIM_CANDIDATES_SQL, [nowIso]);
  for (const candidate of candidates) {
    const result = await db.write(CLAIM_IMPORT_SQL, [
      workerId,
      leaseExpiresAt,
      nowIso,
      candidate.id,
      nowIso,
    ]);
    if (result.changes === 0) continue;
    const row = await readImportRow(db, candidate.id);
    if (row !== null) return toClaimedImport(row);
  }
  return null;
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
 * any rows a prior scan left behind, set `progress.total`, clear
 * `scan_pending`, and renew the lease because a large scan takes a while.
 *
 * `progress.current` goes back to zero with them. A re-scan replaces the file
 * rows wholesale, so the previous attempt's per-file counter no longer refers
 * to anything; leaving it would report a completion rate against the NEW total
 * that this run has not earned, and above 100% when the re-scan finds fewer
 * files.
 *
 * One transaction, so the delete and the inserts cannot be observed apart.
 */
export async function setImportFiles(
  id: ObjectId,
  files: ImportFileEntry[],
  leaseMs: number,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<void> {
  const { hex, nowIso, leaseExpiresAt } = leaseStamps(id, leaseMs, now);
  await sqliteDb(dbOverride).transaction([
    { sql: `DELETE FROM import_files WHERE import_id = ?`, params: [hex] },
    ...insertFileStatements(hex, files),
    {
      sql: `UPDATE imports
               SET scan_pending = 0, progress_total = ?, progress_current = 0,
                   lease_expires_at = ?, updated_at = ?
             WHERE id = ?`,
      params: [files.length, leaseExpiresAt, nowIso, hex],
    },
  ]);
}

/**
 * Persist one file's outcome and renew the lease. `index` is the file's `idx`;
 * `current` is the count processed so far. Counts are recomputed by the caller
 * and written wholesale so a re-claim after a crash cannot double-count.
 *
 * Both writes are one transaction, and the import-level update carries the
 * file row's existence in its own `WHERE`. That is what makes the throw below
 * safe to raise after the commit: when the file row is missing, the guard is
 * false, neither statement changed anything, and the import's counters have not
 * advanced against per-file state that did not move. The worker turns the throw
 * into a failed import and a retry re-runs the file deterministically.
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
  },
  leaseMs: number,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<void> {
  const { hex, nowIso, leaseExpiresAt } = leaseStamps(id, leaseMs, now);
  const results = await sqliteDb(dbOverride).transaction([
    {
      sql: `UPDATE import_files SET state = ?, error = ?, dest = ?
             WHERE import_id = ? AND idx = ?`,
      params: [args.state, args.error, args.destRel, hex, args.index],
    },
    {
      sql: `UPDATE imports
               SET progress_current = ?, count_copied = ?, count_skipped = ?, count_failed = ?,
                   lease_expires_at = ?, updated_at = ?
             WHERE id = ?
               AND EXISTS (SELECT 1 FROM import_files WHERE import_id = ? AND idx = ?)`,
      params: [
        args.current,
        args.counts.copied,
        args.counts.skipped,
        args.counts.failed,
        leaseExpiresAt,
        nowIso,
        hex,
        hex,
        args.index,
      ],
    },
  ]);
  if (changesAt(results, 0) !== 1) {
    throw new Error(
      `updateImportProgress: no import_files row for import ${hex} idx ${args.index}`,
    );
  }
}

/**
 * Extend the claim's lease without recording file progress. Called on a timer
 * so a single long file copy (a large movie) cannot outlive the lease and let a
 * sibling runner reclaim the import mid-copy.
 */
export async function renewImportLease(
  id: ObjectId,
  leaseMs: number,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<void> {
  const { hex, nowIso, leaseExpiresAt } = leaseStamps(id, leaseMs, now);
  await sqliteDb(dbOverride).write(
    `UPDATE imports SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`,
    [leaseExpiresAt, nowIso, hex],
  );
}

/** The three terminal transitions differ only in status and payload. */
async function finishImport(
  db: SqliteDb,
  hex: string,
  assignments: string,
  params: SqlValue[],
  nowIso: string,
): Promise<void> {
  await db.write(
    `UPDATE imports SET ${assignments}, locked_by = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ?`,
    [...params, nowIso, hex],
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
): Promise<void> {
  const clearError = status === 'done' ? `, error = NULL` : '';
  await finishImport(
    sqliteDb(dbOverride),
    toHex(id),
    `status = '${status}', count_copied = ?, count_skipped = ?, count_failed = ?${clearError}`,
    [counts.copied, counts.skipped, counts.failed],
    now().toISOString(),
  );
}

export async function completeImport(
  id: ObjectId,
  counts: ImportCounts,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<void> {
  await finishWithCounts('done', id, counts, now, dbOverride);
}

export async function failImport(
  id: ObjectId,
  error: string,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<void> {
  await finishImport(
    sqliteDb(dbOverride),
    toHex(id),
    `status = 'failed', error = ?`,
    [error],
    now().toISOString(),
  );
}

export async function markImportCancelled(
  id: ObjectId,
  counts: ImportCounts,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<void> {
  await finishWithCounts('cancelled', id, counts, now, dbOverride);
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
