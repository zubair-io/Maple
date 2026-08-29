/**
 * Retry for a failed (or partially-failed) import.
 *
 * Split out of `repo.ts`, which was one commit away from the 600-line hard
 * ceiling. This is the one accessor with real branching — a scan-level
 * failure re-queues for a fresh scan, a per-file failure recovers only the
 * rows whose destination is still safe — so it reads better on its own than
 * buried among the thin CRUD wrappers it sat with.
 */

import type { ObjectId, WithId } from 'mongodb';
import { importsCollection, importFilesCollection } from '../db/client.ts';
import { isSafeLabel } from './dest.ts';
import { isSafeFilename } from '../backup/path-formatter.ts';
import { getImportFiles, type ImportFileEntryWithIdx } from './repo.ts';
import type { ImportDoc, ImportFileState, ImportStatus } from '../db/schema.ts';

/**
 * Re-queue a failed (or partially-failed `done`) import so a worker re-claims
 * it. Resets every `failed` file back to `pending`, clears the import-level
 * `error`, zeroes `counts.failed`, sets status back to `pending`, and clears
 * the lease + cancel flag. Already-copied / skipped files keep their state, so
 * the worker doesn't re-copy them (a copied image dedup-skips on the re-run).
 *
 * Guarded to terminal-with-failures: only a `failed` import, or a `done`
 * import with `counts.failed > 0`, can be retried. Returns true when an import
 * matched the guard and at least one file was actually re-queued, false
 * otherwise (not found / not retryable / nothing recoverable).
 *
 * Two recovery shapes (#800):
 *   - Re-scan (a `failed` import with NO file rows): a scan-level / auto-import
 *     failure that never produced files — e.g. the deferred scan rejected an
 *     unsafe temp name (`.LrTmp-….mp4`) and bailed before writing any files[].
 *     Re-queue for a FRESH scan (`scan_pending: true`, `files` left empty); the
 *     worker walks `source_root` again, this time skipping the hidden/temp
 *     files that are now filtered on scan (#793). Safe — there are no copied
 *     states to lose.
 *   - Per-file recovery (an import that produced file rows): resets every
 *     recoverable `failed` file back to `pending` and keeps `scan_pending`
 *     false so the worker re-uses the resolved files (never re-scans, which
 *     would rebuild files[] and lose the copied states). A `failed` import
 *     with files but NONE recoverable (all permanently-unsafe dests) stays
 *     failed/409 — re-scanning wouldn't help, the names are still unsafe.
 *
 * A file whose destination is permanently unsafe (e.g. a backslash filename
 * that can never pass `destRelPath`) is left `failed`, not resurrected — the
 * re-run must never copy a file with an unvalidated dest. `counts.failed` is
 * recomputed to reflect those stay-failed entries so the import doesn't report
 * a clean run when some files are unrecoverable.
 *
 * Recoverable file rows are flipped back to `pending` in the `import_files`
 * collection; the import doc's status/counts are reset last so a worker can't
 * re-claim until the file rows are ready.
 */
function destIsSafe(dest: string): boolean {
  // A dest can now be `<year>/<label>/<filename>` (explicit override),
  // `<year>/misc/<folder>/<filename>` or `<year>/<parent>/<folder>/<filename>`
  // (the two no-override defaults — see dest.ts), or an arbitrary-depth
  // existing-asset folder path (a nearby-match placement). At least one
  // directory segment plus the filename is required; every directory segment
  // and the filename are re-validated exactly as `destRelPath*` would — a
  // retry must never resurrect a file to an unvalidated path.
  const parts = dest.split('/');
  if (parts.length < 2) return false;
  const filename = parts[parts.length - 1];
  const dirs = parts.slice(0, -1);
  return dirs.every((seg) => isSafeLabel(seg)) && isSafeFilename(filename);
}

/** Fields every retry path resets on the import doc, whichever branch it
 * took: the doc goes back to `pending` with its error and claim cleared. */
function requeueFields(nowIso: string): Record<string, unknown> {
  return {
    status: 'pending' as ImportStatus,
    error: null,
    locked_by: null,
    lease_expires_at: null,
    cancel_requested: false,
    updated_at: nowIso,
  };
}

/**
 * Re-scan branch: a scan-level / auto-import failure that never produced file
 * rows. There's nothing per-file to recover, so re-queue for a FRESH scan —
 * the worker re-walks `source_root` (skipping the hidden/temp files now
 * filtered on scan, #793). Safe because no copied states exist to lose. This
 * is also the path that recovers the 16-MiB-overflow failure: the old scan
 * threw before any file row landed.
 */
async function requeueForRescan(
  id: ObjectId,
  fromStatus: ImportStatus,
  nowIso: string,
): Promise<boolean> {
  const c = await importsCollection();
  const result = await c.updateOne(
    { _id: id, status: fromStatus },
    { $set: { ...requeueFields(nowIso), scan_pending: true } },
  );
  return result.modifiedCount > 0;
}

/**
 * Split the file rows into the failures worth re-attempting and the ones that
 * must stay failed. A file whose destination is permanently unsafe (e.g. a
 * backslash filename that can never pass `destRelPath`) is never resurrected —
 * the re-run must not copy a file with an unvalidated dest. Copied / skipped /
 * pending rows are untouched: already-copied images dedup-skip on the re-run,
 * so nothing is re-copied.
 */
function partitionFailures(fileRows: ImportFileEntryWithIdx[]): {
  recoverableIdxs: number[];
  stillFailed: number;
} {
  const failed = fileRows.filter((f) => f.state === 'failed');
  const recoverable = failed.filter((f) => destIsSafe(f.dest));
  return {
    recoverableIdxs: recoverable.map((f) => f.idx),
    stillFailed: failed.length - recoverable.length,
  };
}

/**
 * Per-file branch: flip the recoverable rows back to `pending`, then reset the
 * import doc. If a crash lands between the two, the file rows are pending but
 * the import is still `failed` — a subsequent retry re-runs idempotently (same
 * rows, same result), and no worker can claim a still-`failed` import
 * meanwhile.
 */
async function requeueRecoveredFiles(
  doc: WithId<ImportDoc>,
  recoverableIdxs: number[],
  stillFailed: number,
  nowIso: string,
): Promise<boolean> {
  const filesColl = await importFilesCollection();
  await filesColl.updateMany(
    { import_id: doc._id, idx: { $in: recoverableIdxs } },
    { $set: { state: 'pending' as ImportFileState, error: null } },
  );

  const c = await importsCollection();
  const result = await c.updateOne(
    { _id: doc._id, status: doc.status },
    {
      $set: {
        ...requeueFields(nowIso),
        // Keep the prior copied/skipped tallies (those files stay put on the
        // re-run); only `failed` is recomputed to the still-unrecoverable count.
        counts: {
          copied: doc.counts?.copied ?? 0,
          skipped: doc.counts?.skipped ?? 0,
          failed: stillFailed,
        },
        // Re-running an Auto Import re-uses the resolved files — never re-scan,
        // which would rebuild the file rows and lose the copied states.
        scan_pending: false,
      },
    },
  );
  return result.modifiedCount > 0;
}

export async function retryImport(
  id: ObjectId,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const c = await importsCollection();
  const doc = (await c.findOne({ _id: id })) as WithId<ImportDoc> | null;
  if (!doc) return false;

  const retryable =
    doc.status === 'failed' || (doc.status === 'done' && (doc.counts?.failed ?? 0) > 0);
  if (!retryable) return false;

  const nowIso = now().toISOString();
  const fileRows = await getImportFiles(id);
  if (doc.status === 'failed' && fileRows.length === 0) {
    return requeueForRescan(id, doc.status, nowIso);
  }

  const { recoverableIdxs, stillFailed } = partitionFailures(fileRows);
  // Nothing recoverable among the file rows — a no-op retry isn't meaningful
  // (only permanently-unsafe failures remain). The fileless case is handled by
  // the re-scan branch above, so reaching here means there ARE file rows and
  // re-scanning wouldn't help (same unsafe names).
  if (recoverableIdxs.length === 0) return false;

  return requeueRecoveredFiles(doc, recoverableIdxs, stillFailed, nowIso);
}
