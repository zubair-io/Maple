/**
 * The discover sweep frontier — the queue of directories still to visit, in
 * Mongo so the walk's memory is O(one directory). Claim is atomic
 * (findOneAndUpdate) so only one sweeper visits a given dir; a lease lets a
 * crashed sweeper's dir be retaken.
 */
import { ObjectId, type WithId } from 'mongodb';
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
    // E11000 duplicate key is expected on re-seed; rethrow anything else.
    const code = (err as { code?: number }).code;
    if (code !== 11000 && !(err as { writeErrors?: unknown[] }).writeErrors) throw err;
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
