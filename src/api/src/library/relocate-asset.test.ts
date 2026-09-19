/**
 * Integration tests for `relocateAsset` (#2629) — the catalogue-aware
 * orchestrator built on the generic `relocateFile` primitive.
 *
 * Real temp directories + real files (no mocks for the filesystem or sidecar
 * layer), and one real SQLite database per test (#3787), installed as the
 * process-wide handle so the orchestrator's own repository calls reach it.
 * Nothing external, so nothing to skip on.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../db/object-id.ts';
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
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';
import { relocateAsset } from './relocate-asset.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-asset-'));
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
 * test can assert `relocateAsset` actually resets it rather than merely
 * leaving already-zero fields alone. */
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

/** One asset located at `relPath`/`filename` under the temp `root`, with the
 * in-memory library-roots cache wired to resolve it. */
function seedAsset(
  db: Database,
  relPath: string,
  filename: string,
): { id: ObjectId; libraryId: ObjectId } {
  const libraryId = insertFolder(db, { path: root, slug: 'relocate-asset-test' });
  const id = insertAsset(db);
  insertLocation(db, { assetId: id, libraryId, path: relPath, filename });
  seedDirtyStages(db, id);
  setLibraryRootsForTests(new Map([[libraryId, root]]));
  return { id: new ObjectId(id), libraryId: new ObjectId(libraryId) };
}

interface LocationRow {
  library_id: string;
  path: string;
  filename: string;
}

function locations(db: Database, id: ObjectId): LocationRow[] {
  return db
    .query(
      `SELECT library_id, path, filename FROM asset_locations
        WHERE asset_id = ? ORDER BY ordinal`,
    )
    .all(id.toHexString()) as LocationRow[];
}

interface StageRow {
  version: number;
  attempts: number;
  last_error: string | null;
  dead: number;
}

function stage(db: Database, id: ObjectId, name: string): StageRow {
  return db
    .query(
      `SELECT version, attempts, last_error, dead FROM stage_state
        WHERE asset_id = ? AND stage = ?`,
    )
    .get(id.toHexString(), name) as StageRow;
}

/** A stage row was reset to the post-relocate baseline the ticket's step 7
 * (bump the thumb/preview stage-version) requires. */
function expectStageReset(row: StageRow): void {
  expect(row.version).toBe(0);
  expect(row.attempts).toBe(0);
  expect(row.last_error).toBeNull();
  expect(row.dead).toBe(0);
}

describe('relocateAsset', () => {
  test('move: repoints the location, resets thumb/preview + meili, deletes the source', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    const { id } = seedAsset(live.db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('relocated');
    if (result.kind !== 'relocated') return;
    expect(result.newPath).toBe('b');
    expect(result.newFilename).toBe('IMG_1.dng');
    expect(result.renamedOnCollision).toBe(false);
    expect(await exists('a/IMG_1.dng')).toBe(false);
    expect(await read('b/IMG_1.dng')).toBe('pixels');

    const row = locations(live.db, id)[0]!;
    expect(row.path).toBe('b');
    expect(row.filename).toBe('IMG_1.dng');
    expectStageReset(stage(live.db, id, 'thumb'));
    expect(stage(live.db, id, 'preview').version).toBe(0);
    expect(stage(live.db, id, 'meili').version).toBe(0);
  });

  test('copy: the row stays untouched — the source asset keeps its identity', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    const { id } = seedAsset(live.db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'copy',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('relocated');
    expect(await exists('a/IMG_1.dng')).toBe(true); // copy mode: source survives
    expect(await read('b/IMG_1.dng')).toBe('pixels');

    // The load-bearing half: a copy must NOT repoint the original asset's
    // location to the duplicate — that would catalog-orphan the untouched
    // source file. The duplicate is the indexer's to discover. The stage
    // rows equally stay dirty: nothing about the source changed.
    const row = locations(live.db, id)[0]!;
    expect(row.path).toBe('a');
    expect(row.filename).toBe('IMG_1.dng');
    expect(stage(live.db, id, 'thumb').version).toBe(3);
  });

  test('multi-location asset: relocate targets the live entry, not a missing-tagged one', async () => {
    using live = await createLiveTestDatabase();
    await write('live/IMG_9.dng', 'pixels');
    const libraryId = insertFolder(live.db, { path: root, slug: 'relocate-asset-test' });
    const assetId = insertAsset(live.db);
    // First entry is missing-tagged (stale/offline location), second is live.
    // The 7173f5e6f selector bug class: a plain "first non-deleted" pick
    // targets the stale copy instead of the live one.
    insertLocation(live.db, {
      assetId,
      libraryId,
      ordinal: 0,
      path: 'stale',
      filename: 'IMG_9.dng',
      missingSince: '2026-02-01T00:00:00.000Z',
    });
    insertLocation(live.db, {
      assetId,
      libraryId,
      ordinal: 1,
      path: 'live',
      filename: 'IMG_9.dng',
    });
    seedDirtyStages(live.db, assetId);
    setLibraryRootsForTests(new Map([[libraryId, root]]));
    const id = new ObjectId(assetId);

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('relocated');
    expect(await read('b/IMG_9.dng')).toBe('pixels');
    // Only the live entry was repointed; the stale one is untouched.
    const rows = locations(live.db, id);
    expect(rows.find((row) => row.path === 'b')?.filename).toBe('IMG_9.dng');
    expect(rows.find((row) => row.path === 'stale')).toBeTruthy();
    expect(rows.find((row) => row.path === 'live')).toBeUndefined();
  });

  test('sidecar follows the asset relocate end-to-end', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    await write('a/IMG_1.xmp', 'edits');
    const { id } = seedAsset(live.db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('relocated');
    expect(await exists('a/IMG_1.xmp')).toBe(false);
    expect(await read('b/IMG_1.xmp')).toBe('edits');
  });

  test('rename: same directory, new filename (destinationFilename)', async () => {
    using live = await createLiveTestDatabase();
    await write('a/old-name.dng', 'pixels');
    const { id } = seedAsset(live.db, 'a', 'old-name.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'a',
      destinationFilename: 'new-name.dng',
    });

    expect(result.kind).toBe('relocated');
    if (result.kind !== 'relocated') return;
    expect(result.newPath).toBe('a');
    expect(result.newFilename).toBe('new-name.dng');
    expect(await exists('a/old-name.dng')).toBe(false);
    expect(await read('a/new-name.dng')).toBe('pixels');
  });

  test('collision auto-suffix repoints the row to the ACTUAL suffixed filename', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    await write('b/IMG_1.dng', 'occupant');
    const { id } = seedAsset(live.db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('relocated');
    if (result.kind !== 'relocated') return;
    expect(result.newFilename).toBe('IMG_1.1.dng');
    expect(result.renamedOnCollision).toBe(true);

    expect(locations(live.db, id)[0]!.filename).toBe('IMG_1.1.dng');
    expect(await read('b/IMG_1.dng')).toBe('occupant'); // untouched
  });

  test('collision skip: no-op, DB and FS both unchanged', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    await write('b/IMG_1.dng', 'occupant');
    const { id } = seedAsset(live.db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'skip',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('skipped');
    expect(await exists('a/IMG_1.dng')).toBe(true);
    expect(locations(live.db, id)[0]!.path).toBe('a'); // DB never touched
  });

  test('a concurrent location change aborts the repoint and leaves the source untouched (failure direction)', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    const { id } = seedAsset(live.db, 'a', 'IMG_1.dng');

    // Simulate a race: something else repoints the entry between our read and
    // the relocate's identity-repoint write, so the address in the repoint's
    // own WHERE no longer matches anything.
    run(
      live.db,
      `UPDATE asset_locations SET path = 'somewhere-else' WHERE asset_id = ?`,
      id.toHexString(),
    );

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('error');
    // Source untouched — the FS-level revert ran because onVerified threw.
    expect(await exists('a/IMG_1.dng')).toBe(true);
    expect(await read('a/IMG_1.dng')).toBe('pixels');
    expect(await exists('b/IMG_1.dng')).toBe(false);
  });

  test('not-found: unknown asset id', async () => {
    using live = await createLiveTestDatabase();
    void live;
    const result = await relocateAsset({
      id: new ObjectId(),
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });
    expect(result.kind).toBe('not-found');
  });

  test('#2725: cross-library move lands the file under the DESTINATION library root, not the source root', async () => {
    using live = await createLiveTestDatabase();
    // A second library, on its own temp root, distinct from `root` (the
    // source library's root that `seedAsset` wires up by default).
    const destRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-asset-dest-'));
    try {
      await write('a/IMG_1.dng', 'pixels');
      const { id, libraryId: sourceLibraryId } = seedAsset(live.db, 'a', 'IMG_1.dng');
      const destLibraryId = insertFolder(live.db, { path: destRoot, slug: 'relocate-asset-dest' });
      setLibraryRootsForTests(
        new Map([
          [sourceLibraryId.toHexString(), root],
          [destLibraryId, destRoot],
        ]),
      );

      const result = await relocateAsset({
        id,
        mode: 'move',
        collision: 'auto-suffix',
        destinationPath: 'b',
        destinationLibraryId: new ObjectId(destLibraryId),
      });

      expect(result.kind).toBe('relocated');
      if (result.kind !== 'relocated') return;
      expect(result.newPath).toBe('b');
      expect(result.newFilename).toBe('IMG_1.dng');

      // The bug this closes: before #2725 the destination relPath was always
      // resolved under the SOURCE library's root, so the file would have
      // landed at `root/b/IMG_1.dng` instead. Assert it lands under the
      // DESTINATION library's root instead.
      expect(await fs.stat(path.join(destRoot, 'b', 'IMG_1.dng')).then(() => true)).toBe(true);
      expect(
        await fs
          .stat(path.join(root, 'b', 'IMG_1.dng'))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      expect(await exists('a/IMG_1.dng')).toBe(false); // source removed (move mode)

      const row = locations(live.db, id)[0]!;
      expect(row.path).toBe('b');
      expect(row.filename).toBe('IMG_1.dng');
      // The location's library_id must follow the file to the destination
      // library — otherwise the catalog row claims the OLD library while the
      // bytes live under the new one.
      expect(row.library_id).toBe(destLibraryId);
    } finally {
      await fs.rm(destRoot, { recursive: true, force: true });
    }
  });

  test('#2725: an unknown destinationLibraryId is rejected as invalid, not silently applied under the source root', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    const { id } = seedAsset(live.db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
      destinationLibraryId: new ObjectId(), // never registered in the roots cache
    });

    expect(result.kind).toBe('invalid');
    expect(await exists('a/IMG_1.dng')).toBe(true); // untouched
    expect(await exists('b/IMG_1.dng')).toBe(false);
  });

  test('already at destination: skipped without touching disk', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    const { id } = seedAsset(live.db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'a',
    });

    expect(result).toEqual({
      kind: 'skipped',
      reason: 'already at destination',
    });
    expect(await read('a/IMG_1.dng')).toBe('pixels');
  });
});

// ---------------------------------------------------------------------------
// Path-traversal defense in depth (jules review on #2669) — relocateAsset
// must reject a hostile destinationPath/destinationFilename itself, not
// merely rely on the HTTP route's own validation, so a future non-HTTP
// caller (or a regression in the route) can't reopen the escape.
// ---------------------------------------------------------------------------

describe('relocateAsset — path traversal is rejected as `invalid`, not attempted', () => {
  test('destinationPath with ../.. traversal is rejected', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    const { id } = seedAsset(live.db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: '../../etc',
    });

    expect(result.kind).toBe('invalid');
    expect(await read('a/IMG_1.dng')).toBe('pixels'); // untouched
  });

  test('an absolute destinationPath is rejected', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    const { id } = seedAsset(live.db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: '/etc',
    });

    expect(result.kind).toBe('invalid');
    expect(await read('a/IMG_1.dng')).toBe('pixels');
  });

  test('a backslash-variant destinationPath is rejected', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    const { id } = seedAsset(live.db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'a\\..\\..\\etc',
    });

    expect(result.kind).toBe('invalid');
    expect(await read('a/IMG_1.dng')).toBe('pixels');
  });

  test('a destinationFilename carrying its own traversal is rejected', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    const { id } = seedAsset(live.db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'a',
      destinationFilename: '../../../etc/passwd',
    });

    expect(result.kind).toBe('invalid');
    expect(await read('a/IMG_1.dng')).toBe('pixels');
  });

  test('a destinationFilename with an embedded path separator is rejected', async () => {
    using live = await createLiveTestDatabase();
    await write('a/IMG_1.dng', 'pixels');
    const { id } = seedAsset(live.db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'a',
      destinationFilename: 'sub/IMG_1.dng',
    });

    expect(result.kind).toBe('invalid');
    expect(await read('a/IMG_1.dng')).toBe('pixels');
  });
});
