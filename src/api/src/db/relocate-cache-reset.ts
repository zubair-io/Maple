/**
 * Shared `fileinfo` repoint fragments for a successful relocate/rename
 * (#2725 fallow-audit finding) — extracted out of `library/relocate-asset.ts`
 * and `workers/discover/rename-reconcile.ts`, which had drifted into an
 * exact clone of both the cache-stage-reset `$set` fragment and the "match
 * the live fileinfo entry we just read" query filter.
 *
 * Deliberately kept separate from `workers/dedupe.helpers.ts`'s own
 * `CACHE_STAGES` / `reArmCacheStages` — a THIRD near-identical copy that
 * also resets `processed_at`, belonging to the dedupe worker's own "the
 * kept copy becomes the new primary" flow. That pair wasn't touched by this
 * diff (fallow-audit didn't flag it — it wasn't part of the changed files),
 * so it's left as-is; consolidating all three is a separate cleanup.
 */
import type { Filter, ObjectId } from 'mongodb';
import type { AssetDoc } from './schema.ts';

/** Cache-writing stages keyed on the asset's path — reset to v0 whenever a
 * relocate/rename moves the file, so the workers regenerate the dropped
 * `.maple` cache at the new location. Never physically relocate cache
 * files themselves — the cache key is path-derived, see docs/caching.md.
 * Not exported: nothing outside `relocateCacheStageResetSet` needs the
 * stage list itself, only the `$set` fragment it produces. */
const RELOCATE_CACHE_STAGES = ['thumb', 'preview'] as const;

/** `$set` fragment resetting every `RELOCATE_CACHE_STAGES` entry to its
 * post-relocate baseline (version 0, no attempts, no error, not dead). */
export function relocateCacheStageResetSet(): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const stage of RELOCATE_CACHE_STAGES) {
    set[`stages.${stage}.version`] = 0;
    set[`stages.${stage}.attempts`] = 0;
    set[`stages.${stage}.last_error`] = null;
    set[`stages.${stage}.dead`] = false;
  }
  return set;
}

/** `updateOne` filter matching an asset BY the exact live `fileinfo` entry
 * being repointed — folding the old `library_id`/`path`/`filename` into the
 * query (not just `_id`) is what makes `matchedCount === 0` a reliable "the
 * entry changed out from under us" signal for a concurrent-mutation guard,
 * rather than the update silently matching but not modifying. */
export function liveFileinfoMatchFilter(
  id: ObjectId,
  entry: { library_id: ObjectId; path: string; filename: string },
): Filter<AssetDoc> {
  return {
    _id: id,
    fileinfo: {
      $elemMatch: {
        library_id: entry.library_id,
        path: entry.path,
        filename: entry.filename,
        deleted_at: null,
      },
    },
  } as Filter<AssetDoc>;
}
