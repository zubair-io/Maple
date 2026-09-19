/**
 * The live-location-count migration.
 *
 * It used to be a backfill for assets written before the column existed. There
 * is no such state under SQLite — the column is `NOT NULL DEFAULT 0` and three
 * triggers derive it from `asset_locations` — so it is a drift check now:
 * count the assets whose stored number disagrees with their actual live
 * locations, and recompute those.
 *
 * Which makes these tests two things at once. They pin the migration's own
 * behaviour, and they pin the liveness rule the triggers implement: a location
 * is live when it carries neither `deleted_at` (its bytes were replaced) nor
 * `missing_since` (its file vanished), and the count is how every browse,
 * search and facet query asks whether an asset is live at all.
 */

import { describe, it, expect } from 'bun:test';
import { backfillLiveLocationCount } from './backfill-live-location-count.ts';
import { assetRow, createLibrary, seedAsset, seedLocation } from './migration.test-helpers.ts';
import type { MigrationLibrary } from './migration.test-helpers.ts';

/** An asset with one location per entry in `states`. */
function withLocations(
  library: MigrationLibrary,
  states: ReadonlyArray<{ missingSince?: string; deletedAt?: string }>,
): string {
  const id = seedAsset(library.db, {});
  states.forEach((state, ordinal) => {
    seedLocation(library.db, {
      assetId: id,
      libraryId: library.folderId,
      ordinal,
      filename: `${id}-${ordinal}.dng`,
      missingSince: state.missingSince ?? null,
      deletedAt: state.deletedAt ?? null,
    });
  });
  return id;
}

const TOMBSTONE = '2026-01-01T00:00:00.000Z';

describe('backfill-live-location-count', () => {
  it('counts a live location, and does not count a tagged one', async () => {
    using library = await createLibrary('maple-llc-');
    const single = withLocations(library, [{}]);
    const multi = withLocations(library, [{}, {}]);
    const missingSibling = withLocations(library, [{}, { missingSince: TOMBSTONE }]);
    const deletedSibling = withLocations(library, [{}, { deletedAt: TOMBSTONE }]);
    const allGone = withLocations(library, [{ missingSince: TOMBSTONE }, { deletedAt: TOMBSTONE }]);

    expect(assetRow(library.db, single)!.live_location_count).toBe(1);
    expect(assetRow(library.db, multi)!.live_location_count).toBe(2);
    expect(assetRow(library.db, missingSibling)!.live_location_count).toBe(1);
    expect(assetRow(library.db, deletedSibling)!.live_location_count).toBe(1);
    expect(assetRow(library.db, allGone)!.live_location_count).toBe(0);
  });

  it('reports nothing to do on a healthy library', async () => {
    using library = await createLibrary('maple-llc-');
    withLocations(library, [{}, { missingSince: TOMBSTONE }]);
    withLocations(library, [{}, {}]);

    expect(await backfillLiveLocationCount.countRemaining()).toBe(0);
    expect(await backfillLiveLocationCount.runBatch(100)).toEqual({ processed: 0, errors: 0 });
  });

  it('finds and repairs a count that has been corrupted out from under the triggers', async () => {
    using library = await createLibrary('maple-llc-');
    const drifted = withLocations(library, [{}, {}]);
    const healthy = withLocations(library, [{}]);
    // Write a wrong value directly, which is the only way to produce drift now
    // that every liveness change goes through the triggers.
    library.db.run(`UPDATE assets SET live_location_count = 7 WHERE id = ?`, [drifted]);

    expect(await backfillLiveLocationCount.countRemaining()).toBe(1);

    const result = await backfillLiveLocationCount.runBatch(100);
    expect(result).toEqual({ processed: 1, errors: 0 });
    expect(assetRow(library.db, drifted)!.live_location_count).toBe(2);
    expect(assetRow(library.db, healthy)!.live_location_count).toBe(1);
    expect(await backfillLiveLocationCount.countRemaining()).toBe(0);
  });

  it('bounds a batch, so a large first run is not one enormous write', async () => {
    using library = await createLibrary('maple-llc-');
    const ids = [
      withLocations(library, [{}]),
      withLocations(library, [{}]),
      withLocations(library, [{}]),
    ];
    for (const id of ids) {
      library.db.run(`UPDATE assets SET live_location_count = 9 WHERE id = ?`, [id]);
    }

    expect(await backfillLiveLocationCount.runBatch(2)).toEqual({ processed: 2, errors: 0 });
    expect(await backfillLiveLocationCount.countRemaining()).toBe(1);
    expect(await backfillLiveLocationCount.runBatch(2)).toEqual({ processed: 1, errors: 0 });
    expect(await backfillLiveLocationCount.countRemaining()).toBe(0);
  });
});
