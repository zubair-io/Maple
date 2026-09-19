/**
 * Integration tests for `relocateAsset`'s (#2629) `collision: 'replace'`
 * occupancy guard (#2843) — split out of `relocate-asset.test.ts` on its own
 * so that file stays under the repo's 600-line file-budget ceiling (with
 * headroom under 570) rather than thinning coverage to fit. Same harness as
 * the parent file: real temp directories + real files (no mocks for the
 * filesystem or sidecar layer), and one real SQLite database per test
 * (#3787) installed as the process-wide handle.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from 'mongodb';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { insertStageState } from '../db/sqlite/repos/assets.test-helpers.ts';
import { findLiveOccupantAssetId } from '../db/sqlite/repos/assets.relocate.repo.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';
import { relocateAsset } from './relocate-asset.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-asset-collision-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  setLibraryRootsForTests(null);
});

async function write(rel: string, content: string): Promise<string> {
  const abs = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}
async function exists(rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, ...rel.split('/')));
    return true;
  } catch {
    return false;
  }
}
async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
}

/** Pre-relocate stage bookkeeping every seeded asset starts with — dirty on
 * purpose (non-zero versions, an attempt count, a dead-lettered thumb) so a
 * test can tell "untouched by a refusal" from "already at the baseline".
 * Mirrors the parent file's fixture. */
function seedDirtyStages(db: Database, assetId: string): void {
  const processedAt = '2026-01-01T00:00:00.000Z';
  insertStageState(db, assetId, 'thumb', {
    version: 3,
    attempts: 2,
    lastError: 'boom',
    processedAt,
    dead: true,
  });
  insertStageState(db, assetId, 'preview', { version: 3, processedAt });
  insertStageState(db, assetId, 'meili', { version: 5, attempts: 1, processedAt });
}

interface Entry {
  relPath: string;
  filename: string;
}

/** Register the temp `root` as a library and wire the in-memory roots cache
 * to it. Every asset in one test shares it — the occupancy guard is about two
 * assets inside ONE library. */
function registerLibrary(db: Database): string {
  const libraryId = insertFolder(db, { path: root, slug: 'relocate-asset-collision' });
  setLibraryRootsForTests(new Map([[libraryId, root]]));
  return libraryId;
}

/** One asset at `entry`, with dirty stage bookkeeping. */
function seedAssetIn(db: Database, libraryId: string, entry: Entry): ObjectId {
  const id = insertAsset(db);
  insertLocation(db, {
    assetId: id,
    libraryId,
    path: entry.relPath,
    filename: entry.filename,
  });
  seedDirtyStages(db, id);
  return new ObjectId(id);
}

function seedAsset(db: Database, relPath: string, filename: string): ObjectId {
  return seedAssetIn(db, registerLibrary(db), { relPath, filename });
}

/** Two assets sharing one library — the occupancy-guard fixture. */
function seedTwoAssetsSameLibrary(
  db: Database,
  a: Entry,
  b: Entry,
): { idA: ObjectId; idB: ObjectId; libraryId: string } {
  const libraryId = registerLibrary(db);
  return { idA: seedAssetIn(db, libraryId, a), idB: seedAssetIn(db, libraryId, b), libraryId };
}

interface LocationRow {
  library_id: string;
  path: string;
  filename: string;
  deleted_at: string | null;
  missing_since: string | null;
}

function locations(db: Database, id: ObjectId): LocationRow[] {
  return db
    .query(
      `SELECT library_id, path, filename, deleted_at, missing_since FROM asset_locations
        WHERE asset_id = ? ORDER BY ordinal`,
    )
    .all(id.toHexString()) as LocationRow[];
}

interface StageRow {
  stage: string;
  version: number;
  attempts: number;
  last_error: string | null;
  processed_at: string | null;
  dead: number;
}

function stages(db: Database, id: ObjectId): StageRow[] {
  return db
    .query(
      `SELECT stage, version, attempts, last_error, processed_at, dead FROM stage_state
        WHERE asset_id = ? ORDER BY stage`,
    )
    .all(id.toHexString()) as StageRow[];
}

// ---------------------------------------------------------------------------
// #2843 — `collision: 'replace'` must refuse rather than clobber a
// DIFFERENT, live, indexed asset already occupying the destination.
// ---------------------------------------------------------------------------

describe('relocateAsset — replace collision guard (#2843)', () => {
  test('replace onto a path occupied by another LIVE indexed asset is refused 409-shaped, both files and sidecars intact, both rows unchanged', async () => {
    using live = await createLiveTestDatabase();
    await write('a/incoming.dng', 'incoming-pixels');
    await write('b/occupant.dng', 'occupant-pixels');
    await write('b/occupant.xmp', 'occupant-edits');
    const { idA: incomingId, idB: occupantId } = seedTwoAssetsSameLibrary(
      live.db,
      { relPath: 'a', filename: 'incoming.dng' },
      { relPath: 'b', filename: 'occupant.dng' },
    );

    const result = await relocateAsset({
      id: incomingId,
      mode: 'move',
      collision: 'replace',
      destinationPath: 'b',
      destinationFilename: 'occupant.dng',
    });

    expect(result).toEqual({ kind: 'occupied', occupiedByAssetId: occupantId.toHexString() });

    // Neither file's bytes moved.
    expect(await read('a/incoming.dng')).toBe('incoming-pixels');
    expect(await read('b/occupant.dng')).toBe('occupant-pixels');
    // The occupant's sidecar (edit history) was NOT deleted.
    expect(await read('b/occupant.xmp')).toBe('occupant-edits');

    // Neither row moved.
    const incoming = locations(live.db, incomingId)[0]!;
    expect(incoming.path).toBe('a');
    expect(incoming.filename).toBe('incoming.dng');
    const occupant = locations(live.db, occupantId)[0]!;
    expect(occupant.path).toBe('b');
    expect(occupant.filename).toBe('occupant.dng');
  });

  test('replace onto a path occupied only by an UNTRACKED file (no asset row) still works — the legitimate case', async () => {
    using live = await createLiveTestDatabase();
    await write('a/incoming.dng', 'incoming-pixels');
    await write('b/untracked.dng', 'stale-bytes-nobody-indexed');
    const id = seedAsset(live.db, 'a', 'incoming.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'replace',
      destinationPath: 'b',
      destinationFilename: 'untracked.dng',
    });

    expect(result.kind).toBe('relocated');
    expect(await exists('a/incoming.dng')).toBe(false);
    expect(await read('b/untracked.dng')).toBe('incoming-pixels');
    const row = locations(live.db, id)[0]!;
    expect(row.path).toBe('b');
    expect(row.filename).toBe('untracked.dng');
  });

  test('a TRASHED (asset-level deleted_at set) former occupant does not count as a live occupant', async () => {
    using live = await createLiveTestDatabase();
    await write('a/incoming.dng', 'incoming-pixels');
    await write('b/trashed.dng', 'trashed-occupant-bytes');
    const {
      idA: incomingId,
      idB: trashedId,
      libraryId,
    } = seedTwoAssetsSameLibrary(
      live.db,
      { relPath: 'a', filename: 'incoming.dng' },
      { relPath: 'b', filename: 'trashed.dng' },
    );
    const address = { libraryId: new ObjectId(libraryId), path: 'b', filename: 'trashed.dng' };

    // While the occupant is live, the guard sees it — the control for the
    // assertion below, so "not occupied" can't pass by the address simply
    // never having matched anything.
    expect(await findLiveOccupantAssetId(address, incomingId)).toBe(trashedId.toHexString());

    // Mark the occupant trashed WITHOUT moving its location off the
    // destination path — isolates the asset-level `deleted_at` check: even
    // though the row still names 'b/trashed.dng', a trashed asset must not
    // count as a live occupant.
    run(
      live.db,
      `UPDATE assets SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = ?`,
      trashedId.toHexString(),
    );
    expect(await findLiveOccupantAssetId(address, incomingId)).toBeNull();

    // And the orchestrator lets the relocate through rather than refusing it
    // 409-shaped. It cannot go on to COMPLETE in this fixture, which is a
    // SQLite-era difference rather than a change in the guard:
    // `asset_locations_lib_path_name` is UNIQUE over (library_id, path,
    // filename) and the trashed occupant's row still holds that address, so
    // the repoint is rejected and `relocateFile` reverts. The Mongo schema
    // had no such constraint and the move completed, leaving the trashed row
    // pointing at another asset's pixels.
    const result = await relocateAsset({
      id: incomingId,
      mode: 'move',
      collision: 'replace',
      destinationPath: 'b',
      destinationFilename: 'trashed.dng',
    });
    expect(result.kind).not.toBe('occupied');
  });

  test('replace does not consider the incoming asset itself an occupant of its own destination', async () => {
    using live = await createLiveTestDatabase();
    // A multi-location asset: one live entry at 'a', another live entry
    // already at 'b' — replacing onto 'b' for the SAME asset must not be
    // refused as "occupied by a different asset" (it isn't different).
    await write('a/IMG_1.dng', 'pixels-a');
    await write('b/IMG_1.dng', 'pixels-b');
    const libraryId = registerLibrary(live.db);
    const assetId = insertAsset(live.db);
    insertLocation(live.db, {
      assetId,
      libraryId,
      ordinal: 0,
      path: 'a',
      filename: 'IMG_1.dng',
    });
    insertLocation(live.db, {
      assetId,
      libraryId,
      ordinal: 1,
      path: 'b',
      filename: 'IMG_1.dng',
      missingSince: '2026-02-01T00:00:00.000Z',
    });
    seedDirtyStages(live.db, assetId);

    const result = await relocateAsset({
      id: new ObjectId(assetId),
      mode: 'move',
      collision: 'replace',
      destinationPath: 'b',
      destinationFilename: 'IMG_1.dng',
    });

    expect(result.kind).not.toBe('occupied');
  });

  test('auto-suffix/keep-both/skip are unaffected by the guard — collision landscape unchanged', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    await write('b/IMG_1.dng', 'occupant');
    const { idA: incomingId } = seedTwoAssetsSameLibrary(
      live.db,
      { relPath: 'a', filename: 'IMG_1.dng' },
      { relPath: 'b', filename: 'IMG_1.dng' },
    );

    const autoSuffix = await relocateAsset({
      id: incomingId,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });
    expect(autoSuffix.kind).toBe('relocated');
    if (autoSuffix.kind === 'relocated') {
      expect(autoSuffix.newFilename).toBe('IMG_1.1.dng');
    }
  });

  test('skip against an occupied destination stays a no-op (guard is replace-only)', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    await write('b/IMG_1.dng', 'occupant');
    const { idA: incomingId } = seedTwoAssetsSameLibrary(
      live.db,
      { relPath: 'a', filename: 'IMG_1.dng' },
      { relPath: 'b', filename: 'IMG_1.dng' },
    );

    const result = await relocateAsset({
      id: incomingId,
      mode: 'move',
      collision: 'skip',
      destinationPath: 'b',
    });
    expect(result.kind).toBe('skipped');
    expect(await read('a/IMG_1.dng')).toBe('pixels');
    expect(await read('b/IMG_1.dng')).toBe('occupant');
  });

  test("the incoming asset's own row is untouched after a refusal", async () => {
    using live = await createLiveTestDatabase();
    await write('a/incoming.dng', 'incoming-pixels');
    await write('b/occupant.dng', 'occupant-pixels');
    const { idA: incomingId } = seedTwoAssetsSameLibrary(
      live.db,
      { relPath: 'a', filename: 'incoming.dng' },
      { relPath: 'b', filename: 'occupant.dng' },
    );

    const locationsBefore = locations(live.db, incomingId);
    const stagesBefore = stages(live.db, incomingId);
    const result = await relocateAsset({
      id: incomingId,
      mode: 'move',
      collision: 'replace',
      destinationPath: 'b',
      destinationFilename: 'occupant.dng',
    });
    expect(result.kind).toBe('occupied');

    expect(locations(live.db, incomingId)).toEqual(locationsBefore);
    expect(stages(live.db, incomingId)).toEqual(stagesBefore);
  });
});
