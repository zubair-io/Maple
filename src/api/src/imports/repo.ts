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
}

/** Snapshot returned by `claimImport` — enough for the worker to run without
 * re-querying the doc. */
export interface ClaimedImport {
  _id: ObjectId;
  source_root: string;
  library_id: ObjectId;
  library_root: string;
  files: ImportFileEntry[];
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
export async function listImports(
  filter: ListImportsFilter,
): Promise<ImportWithId[]> {
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
  };
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
  const doc = await c.findOne(
    { _id: id },
    { projection: { cancel_requested: 1 } },
  );
  return doc?.cancel_requested === true;
}

/**
 * Content-dedup against the `assets` collection — the same keys the discover
 * watcher uses. True when an asset already exists with this `maple_id` or
 * `sha1_head`, meaning the image is already in the library and the import
 * should skip it.
 */
export async function assetExistsForHash(
  maple_id: string,
  sha1_head: string,
): Promise<boolean> {
  const c = await assetsCollection();
  const byId = await c.findOne(
    { maple_id },
    { projection: { _id: 1 } },
  );
  if (byId) return true;
  const byHash = await c.findOne(
    { sha1_head },
    { projection: { _id: 1 } },
  );
  return byHash != null;
}
