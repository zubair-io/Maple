/**
 * The discover sweep frontier — the queue of directories still to visit, in
 * Mongo so the walk's memory is O(one directory). Claim is atomic
 * (findOneAndUpdate) so only one sweeper visits a given dir; a lease lets a
 * crashed sweeper's dir be retaken.
 */
import type { ObjectId } from 'mongodb';
import { type WithId } from 'mongodb';
import { discoverFrontierCollection } from '../../db/client.ts';
import type { DiscoverFrontierDoc } from '../../db/schema.ts';

export type FrontierDir = WithId<DiscoverFrontierDoc>;

/** Insert the root dir for a fresh generation (no-op if it already exists). */
export async function seedRoot(folderId: ObjectId, rootPath: string, gen: number): Promise<void> {
  await enqueueDirs(folderId, [rootPath], gen);
}

/** Insert child directories for the current generation, ignoring duplicates. */
export async function enqueueDirs(folderId: ObjectId, dirs: string[], gen: number): Promise<void> {
  if (dirs.length === 0) return;
  const coll = await discoverFrontierCollection();
  const now = Date.now();
  const docs: DiscoverFrontierDoc[] = dirs.map((d) => ({
    folder_id: folderId,
    dir_path: d,
    sweep_gen: gen,
    claimed_at: null,
    enqueued_at: now,
  }));
  // ordered:false so a duplicate-key on one dir doesn't drop the rest.
  await coll.insertMany(docs, { ordered: false }).catch((err: unknown) => {
    // ordered:false aggregates per-doc errors in a MongoBulkWriteError.
    // Duplicate-key (11000) is EXPECTED on re-seed and safe to ignore;
    // any other error (auth, network, validation) must propagate so we
    // never silently drop frontier rows.
    //
    // MongoBulkWriteError shape (mongodb driver ≥ 6):
    //   err.code         — top-level code (11000 when ALL errors are dups)
    //   err.writeErrors  — WriteError[], each with a .code getter
    const e = err as { code?: number; writeErrors?: Array<{ code: number }> };
    if (e.code === 11000) return;
    const writeErrors = e.writeErrors ?? [];
    if (writeErrors.length > 0 && writeErrors.every((w) => w.code === 11000)) return;
    throw err;
  });
}

/** Atomically claim the oldest free (or lease-expired) dir for `gen`. */
export async function claimNextDir(
  folderId: ObjectId,
  gen: number,
  leaseMs: number,
): Promise<FrontierDir | null> {
  const coll = await discoverFrontierCollection();
  const now = Date.now();
  const res = await coll.findOneAndUpdate(
    {
      folder_id: folderId,
      sweep_gen: gen,
      $or: [{ claimed_at: null }, { claimed_at: { $lt: now } }],
    },
    { $set: { claimed_at: now + leaseMs } },
    { sort: { enqueued_at: 1, _id: 1 }, returnDocument: 'after' },
  );
  return res as FrontierDir | null;
}

/** Remove a finished dir from the frontier. */
export async function completeDir(id: ObjectId): Promise<void> {
  const coll = await discoverFrontierCollection();
  await coll.deleteOne({ _id: id });
}

/** Rows left for a generation (claimed or not). 0 ⇒ sweep of that gen done. */
export async function remainingForGen(folderId: ObjectId, gen: number): Promise<number> {
  const coll = await discoverFrontierCollection();
  return coll.countDocuments({ folder_id: folderId, sweep_gen: gen });
}
