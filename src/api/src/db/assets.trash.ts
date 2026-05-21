/**
 * Assets repository — trash + restore workflows.
 *
 * Split out of `assets.repo.ts` so the file budget per #205 stays under
 * 400 LOC. These are the multi-step Mongo workflows the trash route
 * used to inline; pulling them in here lets the route stop touching
 * the collection directly while keeping the FS / Meilisearch /
 * change-feed orchestration in the route (the repo doesn't take a
 * Meilisearch dependency).
 */

import {
  type ObjectId,
  type Db,
  type UpdateResult,
  type DeleteResult,
  type Collection,
} from "mongodb";
import { assetsCollection } from "./client.ts";
import { type AssetDoc } from "./schema.ts";

async function coll(dbOverride?: Db): Promise<Collection<AssetDoc>> {
  if (dbOverride) return dbOverride.collection<AssetDoc>("assets");
  return assetsCollection();
}

/**
 * Mark a live asset as soft-deleted and record its pre-trash path.
 * `newAbsPath` is where the FS layer just moved the file; `originalAbsPath`
 * is the location it had before the move. The route writes both; on
 * restore we read `original_path` back out.
 */
export async function markSoftDeleted(args: {
  id: ObjectId;
  newAbsPath: string;
  originalAbsPath: string;
  dbOverride?: Db;
}): Promise<UpdateResult> {
  const c = await coll(args.dbOverride);
  return c.updateOne(
    { _id: args.id },
    {
      $set: {
        abs_path: args.newAbsPath,
        deleted_at: new Date().toISOString(),
        original_path: args.originalAbsPath,
      },
    },
  );
}

/** Permanent purge: drop the doc. Called after the FS layer has
 * removed the file + sidecars. */
export async function hardDelete(
  id: ObjectId,
  dbOverride?: Db,
): Promise<DeleteResult> {
  const c = await coll(dbOverride);
  return c.deleteOne({ _id: id });
}

/**
 * Restore: drop a watcher-inserted transient row at the new abs path
 * (if any), then update the canonical row to point at its new location.
 *
 * The watcher-race delete is bundled in here so the workflow is atomic
 * at the repo layer — splitting it would put two Mongo ops in the route
 * with a Mongo verb in between (the trash route already had this
 * pattern; moving it intact preserves behaviour).
 */
export async function restoreFromTrash(args: {
  id: ObjectId;
  newAbsPath: string;
  filename: string;
  size: number;
  /**
   * Epoch-ms (typically `stat.mtimeMs`). `AssetDoc.mtime` is typed
   * `number` and the assets-list serialiser does `Math.floor(r.mtime /
   * 1000)` — writing an ISO string here NaNs out downstream. The wire
   * response's ISO representation is the route handler's concern (so
   * the Swift File Provider client's Date decoder accepts it); the
   * repo only stores epoch-ms. Fixes #166 regression.
   */
  mtimeMs: number;
  dbOverride?: Db;
}): Promise<UpdateResult> {
  const c = await coll(args.dbOverride);
  // Watcher race: between the FS move and this update, the discover
  // watcher may have observed the file at its new abs_path and inserted
  // a transient row keyed on (folder_id, filename). That row reserves
  // the unique slot and would block the updateOne below — delete any
  // doc at the new abs_path that isn't ours.
  await c.deleteOne({
    abs_path: args.newAbsPath,
    _id: { $ne: args.id },
  });
  return c.updateOne(
    { _id: args.id },
    {
      $set: {
        abs_path: args.newAbsPath,
        filename: args.filename,
        size: args.size,
        mtime: args.mtimeMs,
        deleted_at: null,
        original_path: null,
      },
    },
  );
}
