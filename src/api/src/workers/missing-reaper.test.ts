/**
 * missing-reaper pass tests. Each test owns an in-memory SQLite database
 * installed as the process-wide handle, because a reap pass reaches the
 * repositories with no override — the same way it does in production — plus a
 * real temporary directory standing in for the library root, because the whole
 * point of this worker is what it concludes from the filesystem.
 *
 * `missing_since` is per-LOCATION: the reaper re-stats each tagged location,
 * recovers it if the file reappeared, removes it once aged past the window, and
 * soft-deletes the asset only when no location remains. Covers
 * delete-when-all-gone, per-location cooldown, recover/prune + stage re-arm, the
 * mount guard (offline and empty root), the name-mismatch veto, the circuit
 * breaker, pagination past a clogged batch, and pause-skips-delete-but-still-
 * recovers. Orphan reaping, stage parking and the start/pause/resume control
 * surface live in `missing-reaper.control.test.ts` (split for the file-size
 * budget).
 */

import { describe, it, expect, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMissingReaperOnce } from './missing-reaper.ts';
import { insertStageState, stageState } from '../db/sqlite/repos/assets.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';

const DELETE_BEFORE = '2026-05-10T00:00:00.000Z';
const AGED = '2026-05-01T00:00:00.000Z'; // older than DELETE_BEFORE → delete-eligible
const FRESH = '2026-05-20T00:00:00.000Z'; // newer than DELETE_BEFORE → still in cooldown

/** Temporary library roots to remove once the test that made them has ended. */
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // The roots map is process-global and outlives the per-test database.
  invalidateLibraryRoots();
});

/** A directory holding the named files, cleaned up after the test. */
function makeRoot(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
  tempDirs.push(dir);
  for (const name of files) writeFileSync(join(dir, name), 'x');
  return dir;
}

/** Register `root` as a library and make the roots cache notice it. */
function seedLibrary(db: Database, root: string): string {
  const libraryId = insertFolder(db, { path: root });
  invalidateLibraryRoots();
  return libraryId;
}

/** One location of a fixture asset, at the library root (`path: ''`). */
interface Entry {
  filename: string;
  /** Tags the location `missing_since`. */
  missing?: string;
  /** Tags the location `deleted_at` — content replaced in place (an orphan). */
  deleted?: string;
  missingReason?: string;
}

/** An asset with the given locations in array order, plus any stage rows. */
function seedAsset(
  db: Database,
  libraryId: string,
  entries: Entry[],
  stages: Record<string, Parameters<typeof insertStageState>[3]> = {},
): string {
  const assetId = insertAsset(db);
  entries.forEach((entry, ordinal) => {
    insertLocation(db, {
      assetId,
      libraryId,
      ordinal,
      path: '',
      filename: entry.filename,
      missingSince: entry.missing ?? null,
      deletedAt: entry.deleted ?? null,
    });
    if (entry.missingReason !== undefined) {
      db.run(`UPDATE asset_locations SET missing_reason = ? WHERE asset_id = ? AND filename = ?`, [
        entry.missingReason,
        assetId,
        entry.filename,
      ]);
    }
  });
  for (const [stage, state] of Object.entries(stages)) insertStageState(db, assetId, stage, state);
  return assetId;
}

function assetRow(
  db: Database,
  assetId: string,
): { deleted_at: string | null; reason: string | null } {
  return db
    .query(`SELECT deleted_at, deleted_reason AS reason FROM assets WHERE id = ?`)
    .get(assetId) as { deleted_at: string | null; reason: string | null };
}

/** The tag on one location, or `undefined` when that location is gone. */
function locationTag(
  db: Database,
  assetId: string,
  filename: string,
): { missing_since: string | null; missing_reason: string | null } | undefined {
  return (
    (db
      .query(
        `SELECT missing_since, missing_reason FROM asset_locations
          WHERE asset_id = ? AND filename = ?`,
      )
      .get(assetId, filename) as {
      missing_since: string | null;
      missing_reason: string | null;
    } | null) ?? undefined
  );
}

/** The asset's surviving locations, in array order. */
function filenames(db: Database, assetId: string): string[] {
  return (
    db
      .query(`SELECT filename FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`)
      .all(assetId) as Array<{ filename: string }>
  ).map((row) => row.filename);
}

function assetCount(db: Database): number {
  return (db.query(`SELECT COUNT(*) AS n FROM assets`).get() as { n: number }).n;
}

describe('runMissingReaperOnce', () => {
  it('soft-deletes an asset whose only location is gone and aged past the window (#2977)', async () => {
    using live = await createLiveTestDatabase();
    // The root is available (it holds another file); gone.jpg is genuinely absent.
    const libraryId = seedLibrary(live.db, makeRoot('other.jpg'));
    const assetId = seedAsset(live.db, libraryId, [{ filename: 'gone.jpg', missing: AGED }]);

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.scanned).toBe(1);
    expect(summary.reaped).toBe(1);
    // The record survives as a soft delete — recoverable until trash-gc purges it.
    const row = assetRow(live.db, assetId);
    expect(typeof row.deleted_at).toBe('string');
    expect(row.reason).toBe('reaped');
  });

  it('skips assets already soft-deleted (user-trashed rows belong to trash retention)', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db, makeRoot('other.jpg'));
    const trashedAt = '2026-05-02T00:00:00.000Z';
    const assetId = insertAsset(live.db, { deletedAt: trashedAt });
    insertLocation(live.db, {
      assetId,
      libraryId,
      path: '',
      filename: 'gone.jpg',
      missingSince: AGED,
    });

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    // Not even scanned — soft-deleted assets are out of the candidate set.
    expect(summary.scanned).toBe(0);
    expect(summary.reaped).toBe(0);
    const row = assetRow(live.db, assetId);
    expect(row.deleted_at).toBe(trashedAt);
    expect(row.reason).toBeNull();
  });

  it('a reaped asset is not re-scanned by the next pass', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db, makeRoot('other.jpg'));
    seedAsset(live.db, libraryId, [{ filename: 'gone.jpg', missing: AGED }]);

    const first = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });
    expect(first.reaped).toBe(1);

    const second = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });
    expect(second.scanned).toBe(0);
    expect(second.reaped).toBe(0);
  });

  it('cooldown: leaves an all-gone asset whose location has not been missing long enough', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db, makeRoot('other.jpg'));
    seedAsset(live.db, libraryId, [{ filename: 'gone.jpg', missing: FRESH }]);

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    // Scanned (no boot gate) but not deleted — still inside the prune window.
    expect(summary.scanned).toBe(1);
    expect(summary.skippedCooldown).toBe(1);
    expect(summary.reaped).toBe(0);
    expect(assetCount(live.db)).toBe(1);
  });

  it('paused (allowDelete:false): skips the delete but STILL recovers a re-found file', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db, makeRoot('back.jpg')); // back.jpg is present again
    const gone = seedAsset(live.db, libraryId, [{ filename: 'gone.jpg', missing: AGED }]);
    const back = seedAsset(live.db, libraryId, [{ filename: 'back.jpg', missing: AGED }]);

    const summary = await runMissingReaperOnce({
      deleteBeforeIso: DELETE_BEFORE,
      allowDelete: false,
    });

    // The aged-out all-gone asset is NOT deleted while paused...
    expect(summary.reaped).toBe(0);
    expect(summary.skippedPaused).toBe(1);
    expect(assetRow(live.db, gone).deleted_at).toBeNull();
    // ...but the re-found file still recovers — recovery ignores pause.
    expect(summary.recovered).toBe(1);
    expect(locationTag(live.db, back, 'back.jpg')?.missing_since).toBeNull();
  });

  it('clears the location tag (recovered) when the file is still on disk', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db, makeRoot('here.jpg'));
    const assetId = seedAsset(live.db, libraryId, [{ filename: 'here.jpg', missing: AGED }]);

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.reaped).toBe(0);
    expect(summary.recovered).toBe(1);
    expect(locationTag(live.db, assetId, 'here.jpg')?.missing_since).toBeNull();
  });

  it('recovery clears missing_reason along with missing_since', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db, makeRoot('here.jpg'));
    const assetId = seedAsset(live.db, libraryId, [
      { filename: 'here.jpg', missing: AGED, missingReason: 'watch-removed' },
    ]);

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.recovered).toBe(1);
    expect(locationTag(live.db, assetId, 'here.jpg')).toEqual({
      missing_since: null,
      missing_reason: null,
    });
  });

  it('mount guard: skips (does not delete) when the library root is offline', async () => {
    using live = await createLiveTestDatabase();
    // The library points at a directory that does NOT exist — an unmounted share.
    const offlineRoot = join(tmpdir(), `maple-reaper-offline-${process.pid}-${Date.now()}`);
    const libraryId = seedLibrary(live.db, offlineRoot);
    const assetId = seedAsset(live.db, libraryId, [{ filename: 'gone.jpg', missing: AGED }]);

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.reaped).toBe(0);
    expect(summary.skippedMountOffline).toBe(1);
    expect(locationTag(live.db, assetId, 'gone.jpg')?.missing_since).toBe(AGED);
  });

  it('mount guard: an EMPTY library root is treated as offline (unmounted mountpoint) — #2171', async () => {
    using live = await createLiveTestDatabase();
    // An unmounted bind/network mount is a present-but-empty directory: the root
    // stats fine, every child ENOENTs, and `nearMatchOnDisk` sees an ENOENT
    // parent as 'clear'. Without the non-empty check this asset would be reaped.
    const libraryId = seedLibrary(live.db, makeRoot()); // root left EMPTY
    const assetId = seedAsset(live.db, libraryId, [{ filename: 'gone.jpg', missing: AGED }]);

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.reaped).toBe(0);
    expect(summary.skippedMountOffline).toBe(1);
    expect(assetRow(live.db, assetId).deleted_at).toBeNull();
  });

  it('pages past a batch clogged with paused-undeletable assets so newer ones still recover (#2171)', async () => {
    using live = await createLiveTestDatabase();
    // Production failure mode: the reaper is paused, the oldest `batchSize`
    // assets are all aged+gone (delete-gated → skippedPaused), and the
    // sort-by-oldest batch re-fetches exactly those every pass — so a newer
    // false-tagged asset whose file IS on disk never gets scanned, and never
    // recovers.
    const libraryId = seedLibrary(live.db, makeRoot('back.jpg'));
    seedAsset(live.db, libraryId, [{ filename: 'gone.jpg', missing: AGED }]);
    const starved = seedAsset(live.db, libraryId, [{ filename: 'back.jpg', missing: FRESH }]);

    const summary = await runMissingReaperOnce({
      batchSize: 1, // the first page holds only the aged clog row
      deleteBeforeIso: DELETE_BEFORE,
      allowDelete: false,
    });

    expect(summary.skippedPaused).toBe(1);
    // Pagination reached the second asset and recovered it in the SAME pass.
    expect(summary.recovered).toBe(1);
    expect(locationTag(live.db, starved, 'back.jpg')?.missing_since).toBeNull();
  });

  it('a multi-location asset survives while ANY live location still exists', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db, makeRoot('copy-b.jpg')); // second copy present
    const assetId = seedAsset(live.db, libraryId, [
      { filename: 'copy-a.jpg', missing: AGED }, // tagged missing + gone from disk
      { filename: 'copy-b.jpg' }, // live + present
    ]);

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.reaped).toBe(0);
    expect(summary.recovered).toBe(1);
    // The gone location is removed, leaving only the live copy-b.
    expect(filenames(live.db, assetId)).toEqual(['copy-b.jpg']);
    expect(locationTag(live.db, assetId, 'copy-b.jpg')?.missing_since).toBeNull();
  });

  it('prunes a phantom primary, keeps the asset, and re-arms dead original stages', async () => {
    using live = await createLiveTestDatabase();
    // The IMG_2093 case: a phantom `.1.JPG` at the primary slot (so exif/thumb
    // ENOENT and dead-letter) while the real file is a sibling.
    const libraryId = seedLibrary(live.db, makeRoot('IMG_2093.JPG'));
    const assetId = seedAsset(
      live.db,
      libraryId,
      [{ filename: 'IMG_2093.1.JPG', missing: AGED }, { filename: 'IMG_2093.JPG' }],
      {
        exif: { version: 3, attempts: 5, dead: true, lastError: 'ENOENT' },
        thumb: { version: 3, attempts: 5, dead: true, lastError: 'ENOENT' },
      },
    );

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.reaped).toBe(0);
    expect(summary.recovered).toBe(1);
    expect(summary.prunedEntries).toBe(1);
    expect(filenames(live.db, assetId)).toEqual(['IMG_2093.JPG']);
    // Original-file stages re-queued (version 0, not dead) — a live location remains.
    expect(stageState(live.db, assetId, 'exif')).toMatchObject({
      version: 0,
      dead: 0,
      attempts: 0,
    });
    expect(stageState(live.db, assetId, 'thumb')).toMatchObject({ version: 0, dead: 0 });
  });

  it('does NOT re-arm a stage that is not dead (already processed) on recovery', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db, makeRoot('real.jpg')); // live copy present
    const assetId = seedAsset(
      live.db,
      libraryId,
      [{ filename: 'real.jpg' }, { filename: 'stale.jpg', missing: AGED }],
      { exif: { version: 2 } },
    );

    await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(filenames(live.db, assetId)).toEqual(['real.jpg']);
    // exif already succeeded (not dead) — left untouched, no needless reprocess.
    expect(stageState(live.db, assetId, 'exif')).toMatchObject({ version: 2 });
  });

  it('re-arms a dead original stage on pure recovery (file came back, nothing pruned)', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db, makeRoot('back.jpg')); // file is present again
    const assetId = seedAsset(live.db, libraryId, [{ filename: 'back.jpg', missing: AGED }], {
      exif: { version: 3, attempts: 5, dead: true, lastError: 'ENOENT' },
    });

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.recovered).toBe(1);
    expect(summary.prunedEntries).toBe(0); // nothing absent to prune
    expect(locationTag(live.db, assetId, 'back.jpg')?.missing_since).toBeNull();
    // The previously-dead exif is re-queued so it reprocesses the recovered file.
    expect(stageState(live.db, assetId, 'exif')).toMatchObject({ version: 0, dead: 0 });
  });

  it('name-mismatch guard: never deletes when a case-variant exists on disk', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db, makeRoot('photo.jpg')); // on disk as lowercase
    // Stored uppercase. On a case-sensitive filesystem (Linux/production) the
    // stat ENOENTs and the veto fires; on a case-insensitive one (dev macOS) the
    // stat succeeds and it recovers. Both share the invariant: never deleted.
    const assetId = seedAsset(live.db, libraryId, [{ filename: 'PHOTO.JPG', missing: AGED }]);

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.reaped).toBe(0);
    expect(summary.skippedNameMismatch + summary.recovered).toBe(1);
    expect(assetRow(live.db, assetId).deleted_at).toBeNull();
  });

  it('circuit breaker: flags a mass-reap pass but proceeds (soft-deletes are recoverable)', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db, makeRoot('other.jpg')); // every recorded file gone
    for (let i = 0; i < 40; i++) {
      seedAsset(live.db, libraryId, [{ filename: `gone-${i}.jpg`, missing: AGED }]);
    }

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.breakerTripped).toBe(true);
    // Since #2977 the pass PROCEEDS — every asset is soft-deleted (recoverable
    // for the trash retention window), and the trip surfaces as a worker error.
    expect(summary.reaped).toBe(40);
    expect(assetCount(live.db)).toBe(40); // no record removed
    const reaped = (
      live.db.query(`SELECT COUNT(*) AS n FROM assets WHERE deleted_reason = 'reaped'`).get() as {
        n: number;
      }
    ).n;
    expect(reaped).toBe(40);
  });
});
