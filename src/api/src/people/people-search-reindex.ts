/**
 * Re-index trigger for person-name search.
 *
 * The meili stage folds each asset's named people into its search_blob and
 * the Meilisearch document. Those tokens go stale the moment a person is
 * renamed, merged, (re)assigned, or hidden. Rather than duplicate the
 * stage's upsert logic, we reset the affected assets' `stages.meili.version`
 * to 0 — the worker claim query matches `stages.meili.version <
 * targetVersion` (see `run-stage.ts:buildClaimQuery`), so the runtime
 * re-queues each touched asset through `meiliHandler` on its next tick and
 * repopulates everything from the live row state.
 *
 * Callers invoke this fire-and-forget (logged on error) — a failed reset
 * must never break a rename/merge/assign/hide write.
 */

import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('people:search-reindex');

/**
 * The `$set` fields that re-arm the meili stage on one or more assets:
 * reset the stage version below `meiliStage.targetVersion` so
 * `buildClaimQuery` (`workers/run-stage.ts`) reclaims the doc on its next
 * poll tick, and clear the dead-letter/attempt bookkeeping so a row that
 * previously dead-lettered isn't permanently skipped.
 *
 * Exported so every call site that needs to re-arm meili shares this exact
 * shape instead of hand-rolling a second, subtly different reset — see
 * `markAssetsForMeiliReindex` / `markAssetIdsForMeiliReindex` below and
 * `restoreFromTrash` (`db/assets.trash.ts`), which folds this into the same
 * atomic update that clears `deleted_at` on restore (#2354).
 */
export const MEILI_REARM_SET: Record<string, unknown> = {
  'stages.meili.version': 0,
  'stages.meili.dead': false,
  'stages.meili.attempts': 0,
  'stages.meili.last_error': null,
};

/**
 * Reset `stages.meili.version` (and clear the dead-letter bookkeeping) on
 * every asset that carries a face assigned to one of `personIds`, so the
 * meili stage re-processes them. Person ids are matched as hex strings —
 * `faces[].person_id` is stored as a hex string, not an ObjectId.
 *
 * No-op when `personIds` is empty. Returns the number of assets reset.
 */
export async function markAssetsForMeiliReindex(
  personIds: Array<ObjectId | string>,
): Promise<number> {
  const hexIds = Array.from(
    new Set(
      personIds
        .map((id) => (typeof id === 'string' ? id : id.toHexString()))
        .filter((id) => id.length > 0),
    ),
  );
  if (hexIds.length === 0) return 0;
  const assets = await assetsCollection();
  const result = await assets.updateMany(
    { 'faces.person_id': { $in: hexIds } },
    { $set: MEILI_REARM_SET },
  );
  return result.modifiedCount;
}

/**
 * Fire-and-forget wrapper: schedules the reindex reset and logs (never
 * throws) on failure. Callers use this so a search-index hiccup can't fail
 * the originating people mutation.
 */
export function markAssetsForMeiliReindexBestEffort(personIds: Array<ObjectId | string>): void {
  void markAssetsForMeiliReindex(personIds).catch((err) => {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to mark assets for meili reindex',
    );
  });
}

/**
 * Like `markAssetsForMeiliReindex` but targets specific assets by `_id`.
 * Used by single-asset face mutations (assign/reassign/hide) and by
 * clustering, where the caller already knows exactly which assets changed —
 * resetting a whole person's corpus there would re-queue thousands of
 * unchanged assets. Reserve the person-wide variant for rename/merge, where
 * the name token shifts across every one of a person's assets.
 *
 * No-op when `assetIds` is empty. Returns the number of assets reset.
 */
export async function markAssetIdsForMeiliReindex(assetIds: ObjectId[]): Promise<number> {
  if (assetIds.length === 0) return 0;
  const assets = await assetsCollection();
  const result = await assets.updateMany({ _id: { $in: assetIds } }, { $set: MEILI_REARM_SET });
  return result.modifiedCount;
}

/** Fire-and-forget wrapper for `markAssetIdsForMeiliReindex`. */
export function markAssetIdsForMeiliReindexBestEffort(assetIds: ObjectId[]): void {
  void markAssetIdsForMeiliReindex(assetIds).catch((err) => {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to mark assets for meili reindex',
    );
  });
}
