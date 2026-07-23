/**
 * Missing-reaper row reconciliation — the writes a reap pass performs once a
 * row has been classified: recover/prune a surviving row, and hard-delete a
 * row whose every location is confirmed gone. Extracted from
 * `missing-reaper.ts` to keep that file under the size budget; the pass logic
 * and all classification guards stay there.
 */

import type { ObjectId } from 'mongodb';
import type { assetsCollection } from '../db/client.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import { meilisearchClient } from '../enrichment/meilisearch-client.ts';
import { updateLiveLocationCount } from '../indexer/images.repo.ts';
import { cleanPreviewsCacheForLocation } from '../fs/preview-cache-cleanup.ts';
import type { FileInfo } from '../db/schema.ts';
import {
  hasLiveEntry,
  reArmDeadStages,
  type MissingReaperSummary,
} from './missing-reaper.helpers.ts';

/** A surviving row (keeps ≥1 location after this pass): clear `missing_since`
 * on entries whose file reappeared, `$pull` the entries confirmed gone, and
 * re-arm any dead original-file stage so it reprocesses. `$set` (recover) and
 * `$pull` touch the same `fileinfo` path, so they cannot share one update —
 * recover runs first, then prune (+ re-arm, which is on `stages.*`, a distinct
 * path). Re-arm rides whichever update runs first. Caller guarantees at least
 * one of `recover`/`prune` is non-empty, so this always counts as one
 * recovered (surviving) row. */
export async function reconcileSurvivor(
  coll: Awaited<ReturnType<typeof assetsCollection>>,
  doc: {
    _id: ObjectId;
    fileinfo?: FileInfo[];
    stages?: Record<string, { dead?: boolean }>;
  },
  recover: FileInfo[],
  prune: FileInfo[],
  survivors: FileInfo[],
  summary: MissingReaperSummary,
  libs: ReadonlyMap<string, string>,
): Promise<void> {
  // Re-arm dead stages only when a LIVE location will remain to process —
  // either an originally-live survivor, or one we are recovering this pass.
  // Re-arming while every survivor is still missing would just re-park it.
  const willHaveLive = recover.length > 0 || hasLiveEntry(survivors);
  const reArm = willHaveLive ? reArmDeadStages(doc) : {};
  let reArmApplied = false;

  if (recover.length > 0) {
    await coll.updateOne(
      { _id: doc._id },
      {
        $set: {
          'fileinfo.$[r].missing_since': null,
          'fileinfo.$[r].missing_reason': null,
          ...reArm,
        },
      },
      {
        arrayFilters: [
          {
            $or: recover.map((e) => ({
              'r.library_id': e.library_id,
              'r.path': e.path,
              'r.filename': e.filename,
            })),
          },
        ],
      },
    );
    reArmApplied = true;
  }

  if (prune.length > 0) {
    const update: Record<string, unknown> = {
      $pull: {
        fileinfo: {
          $or: prune.map((p) => ({
            library_id: p.library_id,
            path: p.path,
            filename: p.filename,
          })),
        },
      },
    };
    if (!reArmApplied && Object.keys(reArm).length > 0) update['$set'] = reArm;
    await coll.updateOne({ _id: doc._id }, update as never);
    summary.prunedEntries += prune.length;
    // Previews are path-keyed now — they don't survive a location going
    // away the way maple_id-keyed thumbs do, so clean them up right here
    // instead of leaving the orphan for cache-gc's backstop sweep.
    await cleanRemovedLocationsCache(libs, prune);
  }

  // Recompute live count after any recover/prune mutations on this row.
  await updateLiveLocationCount(coll, doc._id);
  summary.recovered++;
}

/** Best-effort previews-cache cleanup for every removed location. A
 * filesystem failure here must never affect the DB reconciliation it's
 * called alongside — cache-gc's periodic sweep reclaims anything missed. */
async function cleanRemovedLocationsCache(
  libs: ReadonlyMap<string, string>,
  entries: readonly FileInfo[],
): Promise<void> {
  await Promise.all(
    entries.map(async (fi) => {
      const root = libs.get(fi.library_id.toHexString());
      if (!root) return;
      await cleanPreviewsCacheForLocation(root, fi).catch(() => {});
    }),
  );
}

/** Hard-delete a row whose every location is gone, tombstone its search doc,
 * and publish a delete event. The row has no live entry, so route the change
 * event by its first (now-dead) fileinfo entry's library. */
export async function hardDeleteRow(
  coll: Awaited<ReturnType<typeof assetsCollection>>,
  doc: { _id: ObjectId; fileinfo?: FileInfo[]; maple_id?: string },
  libs: ReadonlyMap<string, string>,
): Promise<void> {
  const folderId = doc.fileinfo?.[0]?.library_id ?? null;
  await coll.deleteOne({ _id: doc._id });
  await cleanRemovedLocationsCache(libs, doc.fileinfo ?? []);
  // Tombstone the Meilisearch document. A reaped row was never soft-deleted,
  // so without this the search index keeps surfacing an asset whose Mongo row
  // and on-disk file are both gone until the next full backfill. Best-effort.
  if (doc.maple_id) {
    try {
      await meilisearchClient().tombstone(doc.maple_id);
    } catch {
      /* best-effort — Mongo is canonical, search self-heals on rebuild */
    }
  }
  await recordAndPublishAssetChange({
    kind: 'delete',
    asset_id: doc._id,
    folder_id: folderId,
    abs_path: null,
  });
}
