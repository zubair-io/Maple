/**
 * Shared dedup-hit writer for the discover producer (`handle-event.ts`) —
 * records a (library_id, path, filename) location on an existing row for
 * the same content, used by both the main dedup branch and the E11000
 * race-loser fallback (which were verbatim near-duplicates before this
 * extraction; split out for the file-size budget).
 *
 * Two cases:
 *   - Location not yet on the row → conditional $push. Only appends if no
 *     entry already matches; a concurrent worker may have seen the same
 *     stale read and raced ahead, and the $not/$elemMatch filter makes us
 *     a silent no-op in that case (the winner already did the work).
 *   - Already-known location → clear its per-entry `deleted_at` and
 *     `missing_since`/`missing_reason` (re-discovering a live file at the
 *     location un-parks it from the missing-reaper) and refresh top-level
 *     timestamps. arrayFilters, not a positional index — a concurrent
 *     $push can shift indices between the caller's findOne and this
 *     updateOne.
 *
 * Reviving a soft-deleted row (user trash or reaped, #2977): its search
 * doc was tombstoned, so the meili stage is re-armed in the SAME update or
 * the asset stays invisible in search until the next full backfill. The
 * caller's `dedupSet` clears the doc-level `deleted_at`/`deleted_reason`.
 *
 * Live-location count is recomputed after either write (append adds a live
 * entry; refresh may un-tombstone one).
 */

import type { ObjectId } from 'mongodb';
import type { assetsCollection } from '../../db/client.ts';
import { updateLiveLocationCount } from '../../indexer/images.repo.ts';
import { MEILI_REARM_SET } from '../../people/people-search-reindex.ts';

interface LocationKey {
  library_id: ObjectId;
  path: string;
  filename: string;
}

/**
 * Append `entry` to `row.fileinfo` or refresh the matching entry in place.
 *
 * `keep` — when defined, the known-location refresh also rewrites the
 * entry's `keep` flag (a `.keep` marker may have been added or removed
 * since first index). The race-loser fallback passes undefined and leaves
 * the flag untouched, matching its pre-extraction behavior.
 *
 * Returns 'append' | 'refresh' so the caller can log which path ran.
 */
export async function appendOrRefreshLocation(
  coll: Awaited<ReturnType<typeof assetsCollection>>,
  row: { _id: ObjectId; fileinfo?: unknown; deleted_at?: string | null },
  entry: LocationKey & Record<string, unknown>,
  dedupSet: Record<string, unknown>,
  keep?: boolean,
): Promise<'append' | 'refresh'> {
  const reviveSet = typeof row.deleted_at === 'string' ? MEILI_REARM_SET : {};
  const list = (row.fileinfo ?? []) as LocationKey[];
  const known = list.some(
    (e) =>
      e.library_id.equals(entry.library_id) &&
      e.path === entry.path &&
      e.filename === entry.filename,
  );

  if (!known) {
    await coll.updateOne(
      {
        _id: row._id,
        fileinfo: {
          $not: {
            $elemMatch: {
              library_id: entry.library_id,
              path: entry.path,
              filename: entry.filename,
            },
          },
        },
      },
      {
        $push: { fileinfo: entry as never },
        $set: { ...dedupSet, ...reviveSet },
      },
    );
    await updateLiveLocationCount(coll, row._id);
    return 'append';
  }

  await coll.updateOne(
    { _id: row._id },
    {
      $set: {
        ...dedupSet,
        ...reviveSet,
        'fileinfo.$[entry].deleted_at': null,
        'fileinfo.$[entry].missing_since': null,
        'fileinfo.$[entry].missing_reason': null,
        ...(keep === undefined ? {} : { 'fileinfo.$[entry].keep': keep }),
      },
    },
    {
      arrayFilters: [
        {
          'entry.library_id': entry.library_id,
          'entry.path': entry.path,
          'entry.filename': entry.filename,
        },
      ],
    },
  );
  await updateLiveLocationCount(coll, row._id);
  return 'refresh';
}
