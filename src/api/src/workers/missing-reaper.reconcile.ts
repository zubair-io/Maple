/**
 * Missing-reaper row reconciliation — the writes a reap pass performs once an
 * asset has been classified: recover/prune a surviving asset, and soft-delete
 * (`deleted_at` + `deleted_reason: 'reaped'`, #2977) one whose every location is
 * confirmed gone. Extracted from `missing-reaper.ts` to keep that file under the
 * size budget; the pass logic and all classification guards stay there.
 *
 * Both writes are one repository call each (`assets.sweeps.ts`), because both
 * are now single transactions rather than sequences the worker had to order by
 * hand. What that removed is described on `reconcileSurvivor` below.
 */

import { recordAndPublishAssetChange } from '../db/sqlite/repos/changes.repo.ts';
import { meilisearchClient } from '../enrichment/meilisearch-client.ts';
import {
  reapAsset,
  reconcileLocations,
  type LocationAddress,
  type MissingTaggedAsset,
} from '../db/sqlite/repos/assets.sweeps.ts';
import { stageRearmStatements } from '../db/sqlite/repos/assets.stage-rearm.ts';
import { cleanPreviewsCacheForLocation } from '../fs/preview-cache-cleanup.ts';
import type { FileInfo } from '../db/schema.ts';
import { hasLiveEntry, type MissingReaperSummary } from './missing-reaper.helpers.ts';

/** A classified location as the repository addresses it. */
function address(entry: FileInfo): LocationAddress {
  return {
    libraryId: entry.library_id.toHexString(),
    path: entry.path,
    filename: entry.filename,
  };
}

/**
 * A surviving asset (keeps ≥1 location after this pass): clear the missing tag
 * on locations whose file reappeared, drop the locations confirmed gone, and
 * re-arm any dead original-file stage so it reprocesses.
 *
 * All three land in ONE transaction, and that is the substantive change from
 * the MongoDB version. There, clearing a tag (`$set`) and removing an entry
 * (`$pull`) both addressed the `fileinfo` array and so could not share a single
 * update: the worker issued recover first, then prune, and had to pick one of
 * them for the stage re-arm to ride along with. A crash between the two left an
 * asset half-reconciled — recovered but with its gone sibling still attached, or
 * re-armed for a location that had not been cleared yet. As ordinary rows they
 * are just statements in one batch, so the asset is either fully reconciled or
 * untouched, and the roll-up of live locations commits with them (the
 * `asset_locations` triggers maintain it, so there is no follow-up recount).
 *
 * Re-arm only when a LIVE location will remain — either an originally-live
 * survivor, or one being recovered this pass. Re-arming while every survivor is
 * still missing would just re-park the stage on its next claim. The stage list
 * itself arrives on the asset as `deadStages`: the candidate query already
 * narrowed it to the original-file stages that are actually dead-lettered.
 *
 * The caller guarantees at least one of `recover`/`prune` is non-empty, so this
 * always counts as one recovered (surviving) asset.
 */
export async function reconcileSurvivor(
  doc: MissingTaggedAsset,
  recover: FileInfo[],
  prune: FileInfo[],
  survivors: FileInfo[],
  summary: MissingReaperSummary,
  libs: ReadonlyMap<string, string>,
): Promise<void> {
  const assetId = doc._id.toHexString();
  const willHaveLive = recover.length > 0 || hasLiveEntry(survivors);
  await reconcileLocations({
    assetId,
    recover: recover.map(address),
    prune: prune.map(address),
    extra: willHaveLive ? stageRearmStatements(assetId, doc.deadStages) : [],
  });

  if (prune.length > 0) {
    summary.prunedEntries += prune.length;
    // Previews are path-keyed now — they don't survive a location going
    // away the way maple_id-keyed thumbs do, so clean them up right here
    // instead of leaving the orphan for cache-gc's backstop sweep.
    await cleanRemovedLocationsCache(libs, prune);
  }
  summary.recovered++;
}

/** Best-effort previews-cache cleanup for every removed location. A
 * filesystem failure here must never affect the database reconciliation it's
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

/**
 * Soft-delete an asset whose every location is gone (#2977): set `deleted_at` +
 * `deleted_reason: 'reaped'` instead of removing the record, tombstone its
 * search document, and publish a delete event.
 *
 * The soft delete is GUARDED — it applies only while the asset still has no live
 * location and is not already soft-deleted, so a discover revive (or a user
 * trash) landing between classification and this write turns the reap into a
 * no-op and `reapAsset` reports false. The guard is one column test here
 * (`live_location_count = 0`) where MongoDB needed a nested `$not`/`$elemMatch`
 * over the `fileinfo` array, because the roll-up the locations maintain answers
 * exactly the question that array had to be re-scanned for.
 *
 * No disk I/O happens here: previews stay for a potential revive (cache-gc
 * reclaims orphans after the trash-gc purge), and the asset keeps its locations
 * for revive matching + Trash display.
 */
export async function reapRow(doc: MissingTaggedAsset): Promise<boolean> {
  if (!(await reapAsset(doc._id.toHexString()))) return false;

  // Tombstone the Meilisearch document — the asset must leave search
  // immediately, same as the old hard delete. Best-effort; discover's
  // revive path re-arms the meili stage so the doc comes back if the
  // content reappears.
  if (doc.maple_id) {
    try {
      await meilisearchClient().tombstone(doc.maple_id);
    } catch {
      /* best-effort — the database is canonical, search self-heals on rebuild */
    }
  }
  await recordAndPublishAssetChange({
    kind: 'delete',
    asset_id: doc._id,
    folder_id: doc.fileinfo[0]?.library_id ?? null,
    abs_path: null,
  });
  return true;
}
