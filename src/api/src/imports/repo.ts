/**
 * Mongo accessor for the `imports` collection (ticket #742).
 *
 * Mirrors `job-runner/jobs.repo.ts`: the `imports` collection IS the work
 * queue, so claim/lease lives on the doc. Thin typed wrapper — no business
 * logic — so the routes, the worker, and the tests share one set of field
 * names and can't drift.
 */

import type { ObjectId } from 'mongodb';
import { type WithId } from 'mongodb';
import { importsCollection, importFilesCollection, assetsCollection } from '../db/client.ts';
import type {
  ImportDoc,
  ImportFileDoc,
  ImportFileEntry,
  ImportFileState,
  ImportStatus,
  ImportWithId,
} from '../db/schema.ts';

/** An import file entry plus its stable position in the import. Returned by
 * `getImportFiles` so callers (the worker) can target a single row's progress
 * update by `(import_id, idx)`. */
export type ImportFileEntryWithIdx = ImportFileEntry & { idx: number };

/** Bulk-insert `files` as `import_files` rows for `importId`, numbered by
 * position. Chunked so a folder with hundreds of thousands of files issues
 * bounded `insertMany` batches instead of one giant write — the whole point of
 * splitting these out of the `imports` doc is that no single write approaches
 * MongoDB's 16 MiB document ceiling. No-op for an empty list. */
const INSERT_BATCH = 5_000;
async function insertImportFiles(importId: ObjectId, files: ImportFileEntry[]): Promise<void> {
  if (files.length === 0) return;
  const coll = await importFilesCollection();
  for (let start = 0; start < files.length; start += INSERT_BATCH) {
    const slice = files.slice(start, start + INSERT_BATCH);
    const docs: ImportFileDoc[] = slice.map((f, i) => ({
      ...f,
      import_id: importId,
      idx: start + i,
    }));
    await coll.insertMany(docs, { ordered: false });
  }
}

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
  scan_pending: boolean;
}

export interface ListImportsFilter {
  status?: ImportStatus;
  limit?: number;
}

/** Insert a pending import. The per-file entries are written to the
 * `import_files` collection (one doc each), NOT inline on the import doc, so a
 * huge folder can't blow past MongoDB's 16 MiB per-document ceiling.
 * `progress.total` is the file count. */
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
  try {
    await insertImportFiles(result.insertedId, input.files);
  } catch (err) {
    // The import doc was inserted first; if the file-row writes fail partway we
    // must not leave a `pending` import with `progress.total > 0` and missing
    // rows — the worker would treat the short read as the whole job and
    // "complete" it with files silently dropped. Roll both back, then rethrow
    // so the caller surfaces the failure.
    const filesColl = await importFilesCollection();
    await filesColl.deleteMany({ import_id: result.insertedId }).catch(() => {});
    await c.deleteOne({ _id: result.insertedId }).catch(() => {});
    throw err;
  }
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
    scan_pending: result.scan_pending ?? false,
  };
}

/**
 * Load an import's per-file entries in stable `idx` order. New imports store
 * these in the `import_files` collection.
 *
 * Pre-migration imports kept the entries inline on the import doc. When the
 * collection has no rows for the id but the doc still carries inline `files`,
 * we hydrate the collection from them on this first read (best-effort) and
 * then serve from the collection — so the worker's progress writes and
 * `retryImport`'s state resets (which only touch `import_files`) land on real
 * rows instead of silently no-opping against a legacy inline array.
 */
export async function getImportFiles(id: ObjectId): Promise<ImportFileEntryWithIdx[]> {
  const coll = await importFilesCollection();
  const rows = await coll.find({ import_id: id }).sort({ idx: 1 }).toArray();
  if (rows.length > 0) {
    return rows.map((r) => ({
      src: r.src,
      dest: r.dest,
      size: r.size,
      mtime: r.mtime,
      kind: r.kind,
      state: r.state,
      error: r.error,
      idx: r.idx,
    }));
  }
  // Legacy fallback + one-time hydration.
  const c = await importsCollection();
  const doc = (await c.findOne({ _id: id }, { projection: { files: 1 } })) as {
    files?: ImportFileEntry[];
  } | null;
  const legacy = doc?.files ?? [];
  if (legacy.length > 0) {
    try {
      await insertImportFiles(id, legacy);
    } catch {
      // Best-effort: a concurrent hydration (duplicate-key on the unique
      // (import_id, idx) index) or a transient write error is fine — the list
      // we return below is still correct for this read, and a later read will
      // see whatever rows did land.
    }
  }
  return legacy.map((f, idx) => ({ ...f, idx }));
}

/**
 * Populate an Auto Import's files after the worker's deferred scan. Writes the
 * resolved entries to the `import_files` collection (clearing any rows from a
 * prior scan so a re-scan starts clean), sets `progress.total`, and clears
 * `scan_pending`. Renews the lease, since a large scan can take a while.
 *
 * This is the write that used to overflow: a single `imports` doc holding the
 * whole `files[]` array tipped past MongoDB's 16 MiB ceiling for big folders
 * and threw a BSON `ERR_OUT_OF_RANGE`. The entries now live one-per-doc, so
 * each `insertMany` batch stays tiny regardless of folder size.
 */
export async function setImportFiles(
  id: ObjectId,
  files: ImportFileEntry[],
  leaseMs: number,
  now: () => Date = () => new Date(),
): Promise<void> {
  const filesColl = await importFilesCollection();
  await filesColl.deleteMany({ import_id: id });
  await insertImportFiles(id, files);

  const c = await importsCollection();
  const nowDate = now();
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  await c.updateOne(
    { _id: id },
    {
      $set: {
        scan_pending: false,
        'progress.total': files.length,
        // A re-scan replaces the file rows wholesale, so the per-file counter
        // from the previous attempt no longer refers to anything. Leaving it
        // would show a completion rate against the NEW total that the run has
        // not earned (and, when the re-scan finds fewer files, one above
        // 100%). The worker starts this run's count at 0; match it here.
        'progress.current': 0,
        lease_expires_at: leaseExpiresAt,
        updated_at: nowDate.toISOString(),
      },
    },
  );
}

/**
 * Persist one file's outcome and renew the lease. `index` is the file's `idx`
 * in the `import_files` collection; `current` is the count processed so far.
 * Counts are recomputed by the caller and written wholesale so a re-claim
 * after a crash can't double-count.
 *
 * Two writes: the per-file row (`import_files`) and the import-doc progress
 * (`imports`). Splitting them is what keeps the import doc bounded — its size
 * no longer grows with the file count.
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
  const filesColl = await importFilesCollection();
  const fileUpdate = await filesColl.updateOne(
    { import_id: id, idx: args.index },
    { $set: { state: args.state, error: args.error, dest: args.destRel } },
  );
  if (fileUpdate.matchedCount !== 1) {
    // The worker only ever reports progress for an `idx` it pulled from
    // `getImportFiles`, so a miss means the row vanished underneath us (a
    // concurrent re-scan/cleanup, or a partial write). Fail loudly rather than
    // bumping the import-level counts against per-file state that didn't move —
    // the worker turns this throw into a failed import, and a retry re-runs the
    // file deterministically.
    throw new Error(
      `updateImportProgress: no import_files row for import ${id.toHexString()} idx ${args.index}`,
    );
  }

  const c = await importsCollection();
  const nowDate = now();
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  await c.updateOne(
    { _id: id },
    {
      $set: {
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
