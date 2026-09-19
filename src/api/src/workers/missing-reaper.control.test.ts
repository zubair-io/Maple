/**
 * missing-reaper tests — orphan (content-replaced) reaping, stage parking, and
 * the start/pause/resume control surface. Split from `missing-reaper.test.ts` to
 * keep that file under the size budget; the reap pass itself (recover/prune/
 * delete, guards, pagination) stays there.
 *
 * Each test owns an in-memory SQLite database. The pass tests and the control
 * tests install theirs as the process-wide handle, because a tick reaches the
 * repositories with no override; the parking test hands its handle to
 * `claimStageBatch` directly, since that is the repository function it is about.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMissingReaperOnce, startMissingReaper, MISSING_REAPER_NAME } from './missing-reaper.ts';
import { stageRegistry } from './registry.ts';
import { claimStageBatch } from '../db/sqlite/repos/stage-claim.ts';
import { insertStageState } from '../db/sqlite/repos/assets.test-helpers.ts';
import {
  createLiveTestDatabase,
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';

const DELETE_BEFORE = '2026-05-10T00:00:00.000Z';
const AGED = '2026-05-01T00:00:00.000Z'; // older than DELETE_BEFORE → delete-eligible

/** Temporary library roots to remove once the test that made them has ended. */
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  invalidateLibraryRoots();
});

/** A directory holding the named files, registered as a library. */
function seedLibrary(db: Database, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  const libraryId = insertFolder(db, { path: dir });
  invalidateLibraryRoots();
  return libraryId;
}

interface Entry {
  filename: string;
  missing?: string;
  deleted?: string;
}

/** An asset with the given locations at the library root, in array order. */
function seedAsset(db: Database, libraryId: string, entries: Entry[]): string {
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
  });
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

/** The persisted pause flag, or `undefined` when the worker has no row yet. */
function storedPaused(db: Database, name: string): boolean | undefined {
  const row = db.query(`SELECT paused FROM worker_config WHERE name = ?`).get(name) as {
    paused: number | null;
  } | null;
  return row?.paused === null || row === null ? undefined : row.paused === 1;
}

function filenames(db: Database, assetId: string): string[] {
  return (
    db
      .query(`SELECT filename FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`)
      .all(assetId) as Array<{ filename: string }>
  ).map((row) => row.filename);
}

// An orphan is an asset whose only content moved away (replaced in place): the
// modified-content guard tombstones the location `deleted_at` AND dual-flags it
// `missing_since` so the reaper reaps the record. The reaper must NOT re-stat a
// `deleted_at` location (a DIFFERENT file may now sit at the path) — it removes
// it blind after the cooldown and soft-deletes the asset.
describe('orphan (content-replaced) reaping', () => {
  it('reaps a dual-flagged orphan after the cooldown WITHOUT re-stating the path', async () => {
    using live = await createLiveTestDatabase();
    // A DIFFERENT file now occupies the orphan's old path. If the reaper
    // re-stat'd it, it would wrongly "recover" the orphan. It must not.
    const libraryId = seedLibrary(live.db, { 'reused.jpg': 'new-content' });
    const assetId = seedAsset(live.db, libraryId, [
      { filename: 'reused.jpg', deleted: AGED, missing: AGED },
    ]);

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.reaped).toBe(1);
    // Soft-deleted (#2977), not removed — recoverable until trash-gc purges it.
    const row = assetRow(live.db, assetId);
    expect(typeof row.deleted_at).toBe('string');
    expect(row.reason).toBe('reaped');
  });

  it('a relinked live location recovers the asset (tag cleared, gone sibling pruned), NOT reaped', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db, { 'relinked.jpg': 'x' }); // re-discovered on disk
    // One location went missing; a re-discover added a live location on disk.
    const assetId = seedAsset(live.db, libraryId, [
      { filename: 'gone.jpg', missing: AGED },
      { filename: 'relinked.jpg' },
    ]);

    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    // The live, on-disk location survives → recovered, not reaped: the gone,
    // aged sibling is removed and the live location is preserved.
    expect(summary.reaped).toBe(0);
    expect(summary.recovered).toBe(1);
    expect(assetRow(live.db, assetId).deleted_at).toBeNull();
    expect(filenames(live.db, assetId)).toEqual(['relinked.jpg']);
  });
});

describe('stage parking', () => {
  it('an asset with no live location is unclaimable, and re-enters once its tag is cleared', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const request = { stage: 'exif', targetVersion: 1, dependsOn: [], limit: 50, maxAttempts: 3 };

    const untagged = insertAsset(handle.db);
    insertLocation(handle.db, { assetId: untagged, libraryId, filename: 'live.jpg' });
    insertStageState(handle.db, untagged, 'exif');
    const tagged = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId: tagged,
      libraryId,
      filename: 'gone.jpg',
      missingSince: AGED,
    });
    insertStageState(handle.db, tagged, 'exif');

    const first = await claimStageBatch(request, db);
    expect(first.claimed.map((row) => row.asset_id)).toEqual([untagged]);

    // Clearing the tag — what the reaper's recovery (or a re-discover) does —
    // re-admits the asset. The already-claimed one is absent from this second
    // batch because its claim holds a lease, not because it was parked.
    run(handle.db, `UPDATE asset_locations SET missing_since = NULL WHERE asset_id = ?`, tagged);
    const second = await claimStageBatch(request, db);
    expect(second.claimed.map((row) => row.asset_id)).toEqual([tagged]);
  });
});

describe('startMissingReaper', () => {
  it('registers a controllable worker whose pause/resume flip live state', async () => {
    // The binding exists for the `using` disposal: the worker reads and writes
    // its persisted pause state on boot and on every pause/resume, and with no
    // database installed those calls would take the swallowed-failure path
    // instead of the one under test.
    using live = await createLiveTestDatabase();
    void live;
    const handle = startMissingReaper({ intervalMs: 3_600_000 }); // long interval — no tick fires
    await handle.ready.catch(() => undefined);
    try {
      expect(stageRegistry.statuses()[MISSING_REAPER_NAME]).toBeDefined();
      await stageRegistry.pause(MISSING_REAPER_NAME);
      expect(stageRegistry.statuses()[MISSING_REAPER_NAME]!.status).toBe('paused');
      await stageRegistry.resume(MISSING_REAPER_NAME);
      expect(stageRegistry.statuses()[MISSING_REAPER_NAME]!.status).toBe('idle');
    } finally {
      handle.stop();
    }
    expect(stageRegistry.statuses()[MISSING_REAPER_NAME]).toBeUndefined();
  });

  it('persists pause across restarts (worker_config), running by default', async () => {
    using live = await createLiveTestDatabase();
    expect(storedPaused(live.db, MISSING_REAPER_NAME)).toBeUndefined();

    // First lifetime: no stored config → boots running by default. Pause it.
    const first = startMissingReaper({ intervalMs: 3_600_000 });
    await first.ready;
    expect(stageRegistry.statuses()[MISSING_REAPER_NAME]!.status).toBe('idle');
    await stageRegistry.pause(MISSING_REAPER_NAME);
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the persist flush
    expect(storedPaused(live.db, MISSING_REAPER_NAME)).toBe(true);
    first.stop();

    // Second lifetime: adopts the stored paused state.
    const second = startMissingReaper({ intervalMs: 3_600_000 });
    await second.ready;
    expect(stageRegistry.statuses()[MISSING_REAPER_NAME]!.status).toBe('paused');
    await stageRegistry.resume(MISSING_REAPER_NAME);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(storedPaused(live.db, MISSING_REAPER_NAME)).toBe(false);
    second.stop();

    // Third lifetime: the resume persisted → boots running again.
    const third = startMissingReaper({ intervalMs: 3_600_000 });
    await third.ready;
    expect(stageRegistry.statuses()[MISSING_REAPER_NAME]!.status).toBe('idle');
    third.stop();
  });
});
