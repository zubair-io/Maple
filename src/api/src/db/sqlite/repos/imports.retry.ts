/**
 * Retry for a failed (or partially-failed) import — the SQLite port of
 * `imports/retry.ts` (#3751).
 *
 * It lives beside {@link file://./imports.repo.ts} rather than inside it for
 * the reason the Mongo split gives: this is the one import accessor with real
 * branching, and it reads better on its own than buried among thin CRUD
 * wrappers. Same exported name, same parameters, same return type, plus the
 * trailing `dbOverride` every module in this directory takes.
 *
 * ## The recovery window the Mongo version has and this one does not
 *
 * On Mongo the file rows are reset first and the import row second, and the
 * comment there explains what happens if the process dies in between: the files
 * are `pending` while the import is still `failed`, which a later retry repairs
 * because no worker can claim a `failed` import meanwhile. Here both writes are
 * one transaction, so that state is unreachable.
 *
 * The transaction also carries the import's status guard into the file-row
 * update. Without it, a concurrent transition — an operator retrying twice, or
 * a worker finishing the import between the read and the write — would reset
 * the file rows while the import row refused to move, which is the one shape
 * the Mongo version can produce and nothing benefits from.
 */

import type { ObjectId } from '../../object-id.ts';
import type { SqlStatement } from '../protocol.ts';
import type { ImportStatus } from '../../schema.ts';
import { isSafeFilename } from '../../../backup/path-formatter.ts';
import { isSafeLabel } from '../../../imports/dest.ts';
import { changesAt, sqliteDb, type SqliteDb } from './db-handle.ts';
import { getImport, getImportFiles, type ImportFileEntryWithIdx } from './imports.repo.ts';
import { placeholders, toHex } from './values.ts';

/**
 * Fields every retry path resets, whichever branch it took: the import goes
 * back to `pending` with its error and its claim cleared.
 */
const REQUEUE_ASSIGNMENTS = `
  status = 'pending', error = NULL, locked_by = NULL, lease_expires_at = NULL,
  cancel_requested = 0, updated_at = ?`;

/** Idxs per `IN (…)` list, well inside SQLite's parameter ceiling. */
const IDX_BATCH = 500;

/**
 * Whether a re-run is allowed to copy to this stored destination.
 *
 * Nothing about the shape of a destination changed in the port — this is the
 * same rule the Mongo retry applies, against the same validators, because a
 * dest that was written before those validators tightened must not be
 * resurrected on the strength of having once been accepted. Every directory
 * segment has to pass `isSafeLabel` and the last one `isSafeFilename`, which is
 * exactly what `destRelPath` demands of a fresh placement.
 *
 * At least one directory plus a filename is required, and that is the only
 * structural assumption: the stored value may be a two-segment explicit
 * override, the three- or four-segment default layouts, or an arbitrary-depth
 * path copied from an existing asset's folder by a nearby-match placement.
 */
function destIsSafe(dest: string): boolean {
  const segments = dest.split('/');
  const filename = segments.at(-1);
  if (filename === undefined || segments.length < 2) return false;
  return segments.slice(0, -1).every(isSafeLabel) && isSafeFilename(filename);
}

/**
 * Split the file rows into the failures worth re-attempting and the ones that
 * must stay failed. A file whose destination is permanently unsafe (a backslash
 * filename, say, which can never pass `destRelPath`) is never resurrected.
 * Copied, skipped and pending rows are untouched: an already-copied image
 * dedup-skips on the re-run, so nothing is re-copied.
 */
function partitionFailures(fileRows: ImportFileEntryWithIdx[]): {
  recoverableIdxs: number[];
  stillFailed: number;
} {
  const failed = fileRows.filter((file) => file.state === 'failed');
  const recoverable = failed.filter((file) => destIsSafe(file.dest));
  return {
    recoverableIdxs: recoverable.map((file) => file.idx),
    stillFailed: failed.length - recoverable.length,
  };
}

/**
 * Re-scan branch: a scan-level or Auto Import failure that never produced file
 * rows. There is nothing per-file to recover, so re-queue for a FRESH scan —
 * the worker re-walks `source_root`, this time skipping the hidden and temp
 * files that are now filtered on scan (#793). Safe because no copied states
 * exist to lose. This is also the path that recovers the old 16 MiB overflow
 * failure, whose scan threw before any file row landed.
 */
async function requeueForRescan(
  db: SqliteDb,
  hex: string,
  fromStatus: ImportStatus,
  nowIso: string,
): Promise<boolean> {
  const result = await db.write(
    `UPDATE imports SET ${REQUEUE_ASSIGNMENTS}, scan_pending = 1 WHERE id = ? AND status = ?`,
    [nowIso, hex, fromStatus],
  );
  return result.changes > 0;
}

/** The statements that flip `idxs` back to `pending`, in bounded batches. */
function resetFileStatements(
  hex: string,
  fromStatus: ImportStatus,
  idxs: number[],
): SqlStatement[] {
  return Array.from({ length: Math.ceil(idxs.length / IDX_BATCH) }, (_unused, batch) => {
    const slice = idxs.slice(batch * IDX_BATCH, (batch + 1) * IDX_BATCH);
    return {
      sql: `UPDATE import_files SET state = 'pending', error = NULL
             WHERE import_id = ? AND idx IN (${placeholders(slice.length)})
               AND EXISTS (SELECT 1 FROM imports WHERE id = ? AND status = ?)`,
      params: [hex, ...slice, hex, fromStatus],
    };
  });
}

/**
 * Per-file branch: flip the recoverable rows back to `pending` and reset the
 * import, in one transaction.
 *
 * `count_copied` and `count_skipped` keep the prior tallies — those files stay
 * put on the re-run — while `count_failed` is recomputed to the number that
 * remains unrecoverable, so the import does not report a clean run when some
 * files can never be copied. `scan_pending` stays false: re-running an Auto
 * Import re-uses the resolved files, and re-scanning would rebuild the rows and
 * lose the copied states.
 */
async function requeueRecoveredFiles(
  db: SqliteDb,
  hex: string,
  fromStatus: ImportStatus,
  counts: { copied: number; skipped: number; stillFailed: number },
  recoverableIdxs: number[],
  nowIso: string,
): Promise<boolean> {
  const resets = resetFileStatements(hex, fromStatus, recoverableIdxs);
  const results = await db.transaction([
    ...resets,
    {
      sql: `UPDATE imports
               SET ${REQUEUE_ASSIGNMENTS}, count_copied = ?, count_skipped = ?,
                   count_failed = ?, scan_pending = 0
             WHERE id = ? AND status = ?`,
      params: [nowIso, counts.copied, counts.skipped, counts.stillFailed, hex, fromStatus],
    },
  ]);
  return changesAt(results, resets.length) > 0;
}

/**
 * Re-queue a failed (or partially-failed `done`) import so a worker re-claims
 * it. Resets every `failed` file back to `pending`, clears the import-level
 * error, recomputes the failure count, sets the status back to `pending`, and
 * clears the lease and the cancel flag. Already-copied and skipped files keep
 * their state, so the worker does not re-copy them.
 *
 * Guarded to terminal-with-failures: only a `failed` import, or a `done` import
 * with `counts.failed > 0`, can be retried. Returns true when an import matched
 * the guard and something was actually re-queued; false otherwise — not found,
 * not retryable, or nothing recoverable.
 *
 * Two recovery shapes (#800), chosen by whether the import produced file rows
 * at all: see {@link requeueForRescan} and {@link requeueRecoveredFiles}.
 */
export async function retryImport(
  id: ObjectId,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const db = sqliteDb(dbOverride);
  const doc = await getImport(id, db);
  if (doc === null) return false;

  const retryable = doc.status === 'failed' || (doc.status === 'done' && doc.counts.failed > 0);
  if (!retryable) return false;

  const hex = toHex(id);
  const nowIso = now().toISOString();
  const fileRows = await getImportFiles(id, db);
  if (doc.status === 'failed' && fileRows.length === 0) {
    return requeueForRescan(db, hex, doc.status, nowIso);
  }

  const { recoverableIdxs, stillFailed } = partitionFailures(fileRows);
  // Nothing recoverable among the file rows — a no-op retry is not meaningful,
  // because only permanently-unsafe failures remain. The fileless case is
  // handled by the re-scan branch above, so reaching here means there ARE file
  // rows and re-scanning would not help: the names are still unsafe.
  if (recoverableIdxs.length === 0) return false;

  return requeueRecoveredFiles(
    db,
    hex,
    doc.status,
    { copied: doc.counts.copied, skipped: doc.counts.skipped, stillFailed },
    recoverableIdxs,
    nowIso,
  );
}
