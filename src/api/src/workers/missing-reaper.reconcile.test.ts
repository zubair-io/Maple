/**
 * `reapRow` tests (#2977) — the reaper's terminal action is a SOFT delete:
 * `deleted_at` + `deleted_reason: 'reaped'` set on the surviving asset, guarded
 * against a concurrent revive and against double-soft-delete.
 *
 * Each test owns an in-memory SQLite database installed as the process-wide
 * handle, because `reapRow` reaches the repositories with no override — the same
 * way it does in production.
 *
 * The guard is the interesting half. On MongoDB it was a nested
 * `$not`/`$elemMatch` re-scanning the `fileinfo` array inside the update's
 * filter; here it is `live_location_count = 0`, a column the `asset_locations`
 * triggers maintain. These tests pin the behaviour rather than the spelling: a
 * location that came back, or a user trash that landed first, must still make
 * the reap a no-op.
 */

import { describe, it, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from 'mongodb';
import { reapRow } from './missing-reaper.reconcile.ts';
import type { MissingTaggedAsset } from '../db/sqlite/repos/assets.sweeps.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

const MISSING_SINCE = '2026-01-01T00:00:00.000Z';

/**
 * The classified asset the reap pass hands `reapRow` — what `listMissingTagged`
 * would have returned for the seeded rows. Built by hand rather than read back
 * so the already-trashed case, which that query deliberately excludes, can be
 * exercised with the same shape as the others.
 */
function taggedAsset(assetId: string, libraryId: string, filename: string): MissingTaggedAsset {
  return {
    _id: new ObjectId(assetId),
    maple_id: null,
    fileinfo: [
      {
        path: 'sub',
        filename,
        library_id: new ObjectId(libraryId),
        deleted_at: null,
        missing_since: MISSING_SINCE,
        missing_reason: 'enoent',
      },
    ],
    deadStages: [],
  };
}

/** One asset whose only location is tagged missing. */
function seedGoneAsset(
  db: Database,
  filename: string,
  deletedAt: string | null = null,
): MissingTaggedAsset {
  const libraryId = insertFolder(db);
  const assetId = insertAsset(db, { deletedAt });
  insertLocation(db, {
    assetId,
    libraryId,
    path: 'sub',
    filename,
    missingSince: MISSING_SINCE,
  });
  return taggedAsset(assetId, libraryId, filename);
}

function readAsset(
  db: Database,
  id: ObjectId,
): { deleted_at: string | null; deleted_reason: string | null } {
  return db
    .query(`SELECT deleted_at, deleted_reason FROM assets WHERE id = ?`)
    .get(id.toHexString()) as { deleted_at: string | null; deleted_reason: string | null };
}

function locationCount(db: Database, id: ObjectId): number {
  return (db
    .query(`SELECT COUNT(*) AS n FROM asset_locations WHERE asset_id = ?`)
    .get(id.toHexString()) as { n: number } | null)!.n;
}

describe('reapRow', () => {
  it('soft-deletes an all-gone asset instead of removing it', async () => {
    using live = await createLiveTestDatabase();
    const doc = seedGoneAsset(live.db, 'a.dng');

    expect(await reapRow(doc)).toBe(true);

    const after = readAsset(live.db, doc._id);
    expect(typeof after.deleted_at).toBe('string');
    expect(after.deleted_reason).toBe('reaped');
    // Locations untouched — kept for revive matching + Trash display.
    expect(locationCount(live.db, doc._id)).toBe(1);
  });

  it('is a no-op when the asset regained a live location (concurrent revive guard)', async () => {
    using live = await createLiveTestDatabase();
    const doc = seedGoneAsset(live.db, 'b.dng');
    // Simulate discover reviving the location AFTER classification. Clearing the
    // tag puts `live_location_count` back to 1 through the location triggers,
    // which is exactly what the reap's guard tests.
    run(
      live.db,
      `UPDATE asset_locations SET missing_since = NULL, missing_reason = NULL
        WHERE asset_id = ?`,
      doc._id.toHexString(),
    );

    expect(await reapRow(doc)).toBe(false);

    const after = readAsset(live.db, doc._id);
    expect(after.deleted_at).toBeNull();
    expect(after.deleted_reason).toBeNull();
  });

  it('is a no-op on an already user-trashed asset', async () => {
    using live = await createLiveTestDatabase();
    const trashedAt = '2026-08-01T00:00:00.000Z';
    const doc = seedGoneAsset(live.db, 'c.dng', trashedAt);

    expect(await reapRow(doc)).toBe(false);

    const after = readAsset(live.db, doc._id);
    // The user's trash timestamp and reason survive — the reap must not restamp
    // a row that already belongs to the trash retention window.
    expect(after.deleted_at).toBe(trashedAt);
    expect(after.deleted_reason).toBeNull();
  });
});
