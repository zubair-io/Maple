/**
 * Mongo accessor for the `imports` collection (ticket #742).
 *
 * Mirrors `job-runner/jobs.repo.ts`: the `imports` collection IS the work
 * queue, so claim/lease lives on the doc. Thin typed wrapper — no business
 * logic — so the routes, the worker, and the tests share one set of field
 * names and can't drift.
 */

import { ObjectId, type WithId } from 'mongodb';
import { importsCollection, assetsCollection } from '../db/client.ts';
import { isSafeLabel } from './dest.ts';
import { isSafeFilename } from '../backup/path-formatter.ts';
import type {
  ImportDoc,
  ImportFileEntry,
  ImportFileState,
  ImportStatus,
  ImportWithId,
} from '../db/schema.ts';

export interface CreateImportInput {
  source_root: string;
  library_id: ObjectId;
  library_root: string;
  files: ImportFileEntry[];
  /** Auto Import — worker scans `source_root` to fill `files`. Default false. */
  scan_pending?: boolean;
}

/** Snapshot returned by `claimImport` — enough for the worker to run without
 * re-querying the doc. */
export interface ClaimedImport {
  _id: ObjectId;
  source_root: string;
  library_id: ObjectId;
  library_root: string;
  files: ImportFileEntry[];
  scan_pending: boolean;
}

export interface ListImportsFilter {
  status?: ImportStatus;
  limit?: number;
}

/** Insert a pending import. `total` === files.length. */
export async function createImport(
  input: CreateImportInput,
  now: () => Date = () => new Date(),
): Promise<ImportWithId> {
  const c = await importsCollection();
  const nowIso = now().toISOString();
  const doc: ImportDoc = {
    status: 'pending',
    source_root: input.source_root,
    library_id: input.library_id,
    library_root: input.library_root,
    files: input.files,
    scan_pending: input.scan_pending ?? false,
    progress: { current: 0, total: input.files.length },
    counts: { copied: 0, skipped: 0, failed: 0 },
    error: null,
    locked_by: null,
    lease_expires_at: null,
    cancel_requested: false,
    created_at: nowIso,
    updated_at: nowIso,
  };
  const result = await c.insertOne(doc as ImportDoc);
  return { _id: result.insertedId, ...doc } as ImportWithId;
}

export async function getImport(id: ObjectId): Promise<ImportWithId | null> {
  const c = await importsCollection();
  return (await c.findOne({ _id: id })) as ImportWithId | null;
}

/** List imports filtered by status, newest first. Hard-capped at 200. */
export async function listImports(filter: ListImportsFilter): Promise<ImportWithId[]> {
  const c = await importsCollection();
  const q: Record<string, unknown> = {};
  if (filter.status) q.status = filter.status;
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
  const docs = (await c
    .find(q)
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray()) as WithId<ImportDoc>[];
  return docs as ImportWithId[];
}

/**
 * Atomic claim. Same shape as the job runner: a `pending` import with no
 * lock, OR a `running` import whose lease expired (the previous worker died
 * mid-copy). Bumps `locked_by` + `lease_expires_at` + status in one op;
 * Mongo guarantees a single winner.
 *
 * Exclusivity is PER DOCUMENT, not global: only one runner ever processes a
 * given import, but if the API ever runs as multiple processes each with an
 * `ImportRunner`, two *different* pending imports may run concurrently. That
 * is safe by construction — copies are no-clobber (`copy.ts`) and per-file
 * dedup is an atomic `assets` lookup — so concurrent imports into the same
 * library never lose a file. The API is single-process today, so in practice
 * imports run one at a time. A global "one import at a time" gate would be
 * over-restrictive and is intentionally not imposed here.
 */
export async function claimImport(
  workerId: string,
  leaseMs: number,
  now: () => Date = () => new Date(),
): Promise<ClaimedImport | null> {
  const c = await importsCollection();
  const nowDate = now();
  const nowIso = nowDate.toISOString();
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  const filter = {
    $or: [
      { status: 'pending' as ImportStatus, locked_by: null },
      {
        status: 'running' as ImportStatus,
        lease_expires_at: { $lt: nowIso },
      },
    ],
  };
  const update = {
    $set: {
      status: 'running' as ImportStatus,
      locked_by: workerId,
      lease_expires_at: leaseExpiresAt,
      updated_at: nowIso,
    },
  };
  const result = await c.findOneAndUpdate(filter, update, {
    sort: { created_at: 1, _id: 1 },
    returnDocument: 'after',
  });
  if (!result) return null;
  return {
    _id: result._id,
    source_root: result.source_root,
    library_id: result.library_id,
    library_root: result.library_root,
    files: result.files,
    scan_pending: result.scan_pending ?? false,
  };
}

/**
 * Populate an Auto Import's files after the worker's deferred scan. Sets the
 * file list, `progress.total`, and clears `scan_pending`. Renews the lease,
 * since a large scan can take a while.
 */
export async function setImportFiles(
  id: ObjectId,
  files: ImportFileEntry[],
  leaseMs: number,
  now: () => Date = () => new Date(),
): Promise<void> {
  const c = await importsCollection();
  const nowDate = now();
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  await c.updateOne(
    { _id: id },
    {
      $set: {
        files,
        scan_pending: false,
        'progress.total': files.length,
        lease_expires_at: leaseExpiresAt,
        updated_at: nowDate.toISOString(),
      },
    },
  );
}

/**
 * Persist one file's outcome and renew the lease. `index` is the position in
 * `files[]`; `current` is the count processed so far. Counts are recomputed
 * by the caller and written wholesale so a re-claim after a crash can't
 * double-count.
 */
export async function updateImportProgress(
  id: ObjectId,
  args: {
    index: number;
    state: ImportFileState;
    error: string | null;
    destRel: string;
    current: number;
    counts: { copied: number; skipped: number; failed: number };
  },
  leaseMs: number,
  now: () => Date = () => new Date(),
): Promise<void> {
  const c = await importsCollection();
  const nowDate = now();
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  await c.updateOne(
    { _id: id },
    {
      $set: {
        [`files.${args.index}.state`]: args.state,
        [`files.${args.index}.error`]: args.error,
        [`files.${args.index}.dest`]: args.destRel,
        'progress.current': args.current,
        counts: args.counts,
        lease_expires_at: leaseExpiresAt,
        updated_at: nowDate.toISOString(),
      },
    },
  );
}

/**
 * Extend the claim's lease without recording file progress. Called on a timer
 * by the worker so a single long file copy (a large movie) can't outlive the
 * lease and let a sibling runner reclaim the import mid-copy. Scoped to the
 * holding worker so it can't accidentally extend a lease another runner has
 * already taken over.
 */
export async function renewImportLease(
  id: ObjectId,
  leaseMs: number,
  now: () => Date = () => new Date(),
): Promise<void> {
  const c = await importsCollection();
  const nowDate = now();
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  await c.updateOne(
    { _id: id, status: 'running' },
    { $set: { lease_expires_at: leaseExpiresAt, updated_at: nowDate.toISOString() } },
  );
}

export async function completeImport(
  id: ObjectId,
  counts: { copied: number; skipped: number; failed: number },
  now: () => Date = () => new Date(),
): Promise<void> {
  const c = await importsCollection();
  const nowIso = now().toISOString();
  await c.updateOne(
    { _id: id },
    {
      $set: {
        status: 'done' as ImportStatus,
        counts,
        error: null,
        locked_by: null,
        lease_expires_at: null,
        updated_at: nowIso,
      },
    },
  );
}

export async function failImport(
  id: ObjectId,
  error: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const c = await importsCollection();
  const nowIso = now().toISOString();
  await c.updateOne(
    { _id: id },
    {
      $set: {
        status: 'failed' as ImportStatus,
        error,
        locked_by: null,
        lease_expires_at: null,
        updated_at: nowIso,
      },
    },
  );
}

export async function markImportCancelled(
  id: ObjectId,
  counts: { copied: number; skipped: number; failed: number },
  now: () => Date = () => new Date(),
): Promise<void> {
  const c = await importsCollection();
  const nowIso = now().toISOString();
  await c.updateOne(
    { _id: id },
    {
      $set: {
        status: 'cancelled' as ImportStatus,
        counts,
        locked_by: null,
        lease_expires_at: null,
        updated_at: nowIso,
      },
    },
  );
}

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
 * A file whose destination is permanently unsafe (e.g. a backslash filename
 * that can never pass `destRelPath`) is left `failed`, not resurrected — the
 * re-run must never copy a file with an unvalidated dest. `counts.failed` is
 * recomputed to reflect those stay-failed entries so the import doesn't report
 * a clean run when some files are unrecoverable.
 *
 * The `files` array is rewritten wholesale in one atomic update so a
 * concurrent claim can't see a half-reset doc.
 */
function destIsSafe(dest: string): boolean {
  // Mirror `destRelPath`'s invariant exactly: `<year>/<label>/<filename>` —
  // EXACTLY three segments. A retry must never resurrect a file to an
  // unvalidated nested path, so anything but three segments is unsafe.
  const parts = dest.split('/');
  if (parts.length !== 3) return false;
  const [year, label, filename] = parts;
  return isSafeLabel(year) && isSafeLabel(label) && isSafeFilename(filename);
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

  // Reset failed files to pending ONLY when their dest is safe; leave a
  // permanently-unsafe file failed so the re-run never copies an unvalidated
  // dest. Copied/skipped/pending files are untouched (already-copied images
  // dedup-skip on the re-run, so nothing is re-copied).
  let recoveredCount = 0;
  let stillFailed = 0;
  const files: ImportFileEntry[] = doc.files.map((f) => {
    if (f.state !== 'failed') return f;
    if (destIsSafe(f.dest)) {
      recoveredCount += 1;
      return { ...f, state: 'pending' as ImportFileState, error: null };
    }
    stillFailed += 1;
    return f;
  });
  if (recoveredCount === 0) {
    // Nothing recoverable — a no-op retry isn't meaningful (e.g. an empty
    // source whose import failed with no files, or only permanent failures).
    return false;
  }

  const nowIso = now().toISOString();
  const counts = { copied: 0, skipped: 0, ...doc.counts, failed: stillFailed };
  const result = await c.updateOne(
    { _id: id, status: doc.status },
    {
      $set: {
        status: 'pending' as ImportStatus,
        files,
        counts,
        error: null,
        locked_by: null,
        lease_expires_at: null,
        cancel_requested: false,
        // Re-running an Auto Import re-uses the resolved files — never re-scan,
        // which would rebuild files[] and lose the copied states.
        scan_pending: false,
        updated_at: nowIso,
      },
    },
  );
  return result.modifiedCount > 0;
}

/** Flip `cancel_requested`. The worker observes it between files. Returns
 * true if the import exists and is still cancellable (pending/running). */
export async function requestImportCancel(
  id: ObjectId,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const c = await importsCollection();
  const r = await c.updateOne(
    { _id: id, status: { $in: ['pending', 'running'] } },
    { $set: { cancel_requested: true, updated_at: now().toISOString() } },
  );
  return r.matchedCount > 0;
}

export async function isImportCancelRequested(id: ObjectId): Promise<boolean> {
  const c = await importsCollection();
  const doc = await c.findOne({ _id: id }, { projection: { cancel_requested: 1 } });
  return doc?.cancel_requested === true;
}

/**
 * Content-dedup against the `assets` collection — the same keys the discover
 * watcher uses. True when an asset already exists with this `maple_id` or
 * `sha1_head`, meaning the image is already in the library and the import
 * should skip it.
 */
export async function assetExistsForHash(maple_id: string, sha1_head: string): Promise<boolean> {
  const c = await assetsCollection();
  const byId = await c.findOne({ maple_id }, { projection: { _id: 1 } });
  if (byId) return true;
  const byHash = await c.findOne({ sha1_head }, { projection: { _id: 1 } });
  return byHash != null;
}
