/**
 * #5403: a Trash purge erases only the copy the trash action moved into
 * `.maple/trash/`, never another location of a multi-location asset, and
 * refuses any path outside the library's Trash.
 *
 * Real temp library, real files, one real SQLite database per test. The
 * photo is trashed through `trashAssetById` itself, so the location the purge
 * reads is the one the trash action actually recorded.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { trashRoutes } from '../routes/assets/trash.ts';
import { runTrashGcOnce } from '../workers/trash-gc.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { trashAssetById } from './asset-trash.ts';
import { checkTrashPurgeTarget, OutsideTrashError } from './trashed-copy.ts';

const SIXTY_DAYS_AGO = new Date(Date.now() - 60 * 86_400_000).toISOString();
const KEPT_RAW = 'kept-raw-bytes';
const KEPT_XMP = '<x:xmpmeta>kept edit</x:xmpmeta>';

let live: LiveTestDatabase;
let root: string;
let outside: string;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await mkdtemp(path.join(tmpdir(), 'maple-trashed-copy-'));
  outside = await mkdtemp(path.join(tmpdir(), 'maple-trashed-copy-outside-'));
  libraryId = insertFolder(live.db, { path: root });
  invalidateLibraryRoots();
});

afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const abs = (...rel: string[]) => path.join(root, ...rel);

async function write(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

/**
 * One photo stored twice — `kept/IMG_1.dng` first in location order, then
 * `dupe/IMG_1.dng` — each with its own sidecar. The SECOND copy is trashed,
 * so the first live location is the untouched one: the shape where resolving
 * the purge target by list position picks the wrong file.
 */
async function seedDuplicateAndTrashSecondCopy(): Promise<string> {
  await write(abs('kept', 'IMG_1.dng'), KEPT_RAW);
  await write(abs('kept', 'IMG_1.xmp'), KEPT_XMP);
  await write(abs('dupe', 'IMG_1.dng'), KEPT_RAW);
  await write(abs('dupe', 'IMG_1.xmp'), '<x:xmpmeta>dupe edit</x:xmpmeta>');
  const id = insertAsset(live.db);
  run(live.db, `UPDATE assets SET size = ? WHERE id = ?`, KEPT_RAW.length, id);
  insertLocation(live.db, {
    assetId: id,
    libraryId,
    ordinal: 0,
    path: 'kept',
    filename: 'IMG_1.dng',
  });
  insertLocation(live.db, {
    assetId: id,
    libraryId,
    ordinal: 1,
    path: 'dupe',
    filename: 'IMG_1.dng',
  });

  const outcome = await trashAssetById(new ObjectId(id), {
    entry: { libraryId: new ObjectId(libraryId), path: 'dupe', filename: 'IMG_1.dng' },
  });
  expect(outcome.kind).toBe('ok');
  expect(await exists(abs('.maple', 'trash', 'dupe', 'IMG_1.dng'))).toBe(true);
  return id;
}

async function expectOnlyTrashedCopyGone(): Promise<void> {
  expect(await readFile(abs('kept', 'IMG_1.dng'), 'utf8')).toBe(KEPT_RAW);
  expect(await readFile(abs('kept', 'IMG_1.xmp'), 'utf8')).toBe(KEPT_XMP);
  expect(await exists(abs('.maple', 'trash', 'dupe', 'IMG_1.dng'))).toBe(false);
  expect(await exists(abs('.maple', 'trash', 'dupe', 'IMG_1.xmp'))).toBe(false);
}

function expectLiveAtKeptCopy(id: string): void {
  expect(live.db.query(`SELECT deleted_at FROM assets WHERE id = ?`).get(id)).toEqual({
    deleted_at: null,
  });
  expect(live.db.query(`SELECT path FROM asset_locations WHERE asset_id = ?`).all(id)).toEqual([
    { path: 'kept' },
  ]);
}

function assetCount(): number {
  return (live.db.query(`SELECT COUNT(*) AS n FROM assets`).get() as { n: number }).n;
}

describe('purging one trashed copy of a two-location asset (#5403)', () => {
  it('trash-gc erases only the trashed copy and leaves the untouched original byte-identical', async () => {
    const id = await seedDuplicateAndTrashSecondCopy();
    run(live.db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, SIXTY_DAYS_AGO, id);

    const summary = await runTrashGcOnce({ retentionDays: 30 });

    expect(summary).toEqual({ scanned: 1, purged: 1, errors: 0 });
    await expectOnlyTrashedCopyGone();
    expectLiveAtKeptCopy(id);
  });

  it('permanent delete erases only the trashed copy and leaves the untouched original byte-identical', async () => {
    const id = await seedDuplicateAndTrashSecondCopy();
    const app = new Elysia().use(fakeAuth()).group('/api/assets', (g) => g.use(trashRoutes));

    const res = await app.handle(
      new Request(`http://localhost/api/assets/${id}?intent=purge`, { method: 'DELETE' }),
    );

    expect(res.status).toBe(200);
    await expectOnlyTrashedCopyGone();
    expectLiveAtKeptCopy(id);
  });

  it('still purges a trashed photo when its library root carries a .mapleignore marker', async () => {
    await write(abs('solo', 'IMG_4.dng'), KEPT_RAW);
    await write(abs('solo', 'IMG_4.xmp'), KEPT_XMP);
    const id = insertAsset(live.db);
    run(live.db, `UPDATE assets SET size = ? WHERE id = ?`, KEPT_RAW.length, id);
    insertLocation(live.db, { assetId: id, libraryId, path: 'solo', filename: 'IMG_4.dng' });
    expect((await trashAssetById(new ObjectId(id))).kind).toBe('ok');
    await write(abs('.mapleignore'), '');
    run(live.db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, SIXTY_DAYS_AGO, id);

    expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({
      scanned: 1,
      purged: 1,
      errors: 0,
    });
    expect(await exists(abs('.maple', 'trash', 'solo', 'IMG_4.dng'))).toBe(false);
    expect(await exists(abs('.maple', 'trash', 'solo', 'IMG_4.xmp'))).toBe(false);
    expect(assetCount()).toBe(0);
  });

  it('keeps a trashed row with no location inside Trash, and its file', async () => {
    await write(abs('loose', 'IMG_2.dng'), KEPT_RAW);
    const id = insertAsset(live.db, { deletedAt: SIXTY_DAYS_AGO });
    insertLocation(live.db, { assetId: id, libraryId, path: 'loose', filename: 'IMG_2.dng' });

    const summary = await runTrashGcOnce({ retentionDays: 30 });

    expect(summary).toEqual({ scanned: 1, purged: 0, errors: 1 });
    expect(await readFile(abs('loose', 'IMG_2.dng'), 'utf8')).toBe(KEPT_RAW);
    expect(assetCount()).toBe(1);
  });

  it('permanent delete answers 404 for a trashed row with no location inside Trash', async () => {
    await write(abs('loose', 'IMG_2.dng'), KEPT_RAW);
    const id = insertAsset(live.db, { deletedAt: SIXTY_DAYS_AGO });
    insertLocation(live.db, { assetId: id, libraryId, path: 'loose', filename: 'IMG_2.dng' });
    const app = new Elysia().use(fakeAuth()).group('/api/assets', (g) => g.use(trashRoutes));

    const res = await app.handle(
      new Request(`http://localhost/api/assets/${id}?intent=purge`, { method: 'DELETE' }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Asset has no copy in Trash' });
    expect(await readFile(abs('loose', 'IMG_2.dng'), 'utf8')).toBe(KEPT_RAW);
    expect(assetCount()).toBe(1);
  });

  it('keeps the Apple companions while an untrashed copy of the photo remains', async () => {
    const id = await seedDuplicateAndTrashSecondCopy();
    await write(abs('kept', 'IMG_E1.jpg'), 'rendered-edit');
    run(
      live.db,
      `UPDATE assets SET deleted_at = ?, apple_rendered_path = ? WHERE id = ?`,
      SIXTY_DAYS_AGO,
      'kept/IMG_E1.jpg',
      id,
    );

    expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({
      scanned: 1,
      purged: 1,
      errors: 0,
    });

    await expectOnlyTrashedCopyGone();
    expect(await readFile(abs('kept', 'IMG_E1.jpg'), 'utf8')).toBe('rendered-edit');
  });

  it('erases the Apple companions when the only other copy is missing from disk', async () => {
    const id = await seedDuplicateAndTrashSecondCopy();
    await rm(abs('kept', 'IMG_1.dng'));
    await write(abs('kept', 'IMG_E1.jpg'), 'rendered-edit');
    await write(abs('kept', 'IMG_1.mov'), 'live-video');
    run(
      live.db,
      `UPDATE asset_locations SET missing_since = ? WHERE asset_id = ? AND path = 'kept'`,
      SIXTY_DAYS_AGO,
      id,
    );
    run(
      live.db,
      `UPDATE assets SET deleted_at = ?, apple_rendered_path = ?, apple_live_video_path = ?
        WHERE id = ?`,
      SIXTY_DAYS_AGO,
      'kept/IMG_E1.jpg',
      'kept/IMG_1.mov',
      id,
    );

    expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({
      scanned: 1,
      purged: 1,
      errors: 0,
    });

    expect(await exists(abs('.maple', 'trash', 'dupe', 'IMG_1.dng'))).toBe(false);
    expect(await exists(abs('kept', 'IMG_E1.jpg'))).toBe(false);
    expect(await exists(abs('kept', 'IMG_1.mov'))).toBe(false);
  });

  it('still erases the Apple companion when the trashed copy was the only one', async () => {
    await write(abs('solo', 'IMG_3.dng'), KEPT_RAW);
    await write(abs('solo', 'IMG_E3.jpg'), 'rendered-edit');
    const id = insertAsset(live.db);
    run(live.db, `UPDATE assets SET size = ? WHERE id = ?`, KEPT_RAW.length, id);
    insertLocation(live.db, { assetId: id, libraryId, path: 'solo', filename: 'IMG_3.dng' });
    expect((await trashAssetById(new ObjectId(id))).kind).toBe('ok');
    run(
      live.db,
      `UPDATE assets SET deleted_at = ?, apple_rendered_path = ? WHERE id = ?`,
      SIXTY_DAYS_AGO,
      'solo/IMG_E3.jpg',
      id,
    );

    expect((await runTrashGcOnce({ retentionDays: 30 })).purged).toBe(1);

    expect(await exists(abs('.maple', 'trash', 'solo', 'IMG_3.dng'))).toBe(false);
    expect(await exists(abs('solo', 'IMG_E3.jpg'))).toBe(false);
  });
});

describe('checkTrashPurgeTarget', () => {
  it('returns the canonical path of a file inside the library Trash', async () => {
    await write(abs('.maple', 'trash', 'a', 'IMG.dng'), 'x');
    expect(await checkTrashPurgeTarget(abs('.maple', 'trash', 'a', 'IMG.dng'), root)).toBe(
      path.join(await realpath(abs('.maple', 'trash', 'a')), 'IMG.dng'),
    );
  });

  it('reports a target whose Trash directory is gone as absent', async () => {
    expect(await checkTrashPurgeTarget(abs('.maple', 'trash', 'gone', 'IMG.dng'), root)).toBeNull();
  });

  it('refuses a path outside the library Trash', async () => {
    await write(abs('kept', 'IMG.dng'), 'x');
    for (const target of [
      abs('kept', 'IMG.dng'),
      abs('.maple', 'thumbs', 'IMG.avif'),
      abs('.maple', 'trash'),
      abs('.maple', 'trash', '..', '..', 'kept', 'IMG.dng'),
      abs('.maple', 'trash-other', 'IMG.dng'),
      path.join(outside, '.maple', 'trash', 'IMG.dng'),
    ]) {
      await expect(checkTrashPurgeTarget(target, root)).rejects.toBeInstanceOf(OutsideTrashError);
    }
  });

  it('refuses everything when .maple/trash itself is a symlink back into the library', async () => {
    await write(abs('kept', 'IMG.dng'), KEPT_RAW);
    await mkdir(abs('.maple'), { recursive: true });
    await symlink(root, abs('.maple', 'trash'));

    await expect(
      checkTrashPurgeTarget(abs('.maple', 'trash', 'kept', 'IMG.dng'), root),
    ).rejects.toBeInstanceOf(OutsideTrashError);
    expect(await readFile(abs('kept', 'IMG.dng'), 'utf8')).toBe(KEPT_RAW);
  });

  it('throws rather than reporting absent while the library root is unreachable', async () => {
    const unmounted = path.join(outside, 'unmounted-volume');
    await expect(
      checkTrashPurgeTarget(path.join(unmounted, '.maple', 'trash', 'IMG.dng'), unmounted),
    ).rejects.toThrow();
  });

  it('refuses a Trash subdirectory that is a symlink out of the library', async () => {
    await write(path.join(outside, 'IMG.dng'), KEPT_RAW);
    await mkdir(abs('.maple', 'trash'), { recursive: true });
    await symlink(outside, abs('.maple', 'trash', 'escape'));

    await expect(
      checkTrashPurgeTarget(abs('.maple', 'trash', 'escape', 'IMG.dng'), root),
    ).rejects.toBeInstanceOf(OutsideTrashError);
    expect(await readFile(path.join(outside, 'IMG.dng'), 'utf8')).toBe(KEPT_RAW);
  });
});

describe('purging through a symlink inside Trash', () => {
  function trashedRowAt(relDir: string, filename: string): void {
    const id = insertAsset(live.db, { deletedAt: SIXTY_DAYS_AGO });
    insertLocation(live.db, { assetId: id, libraryId, path: relDir, filename });
  }

  it('refuses a trashed copy whose Trash directory links out of the library', async () => {
    await write(path.join(outside, 'IMG_9.dng'), KEPT_RAW);
    await write(path.join(outside, 'IMG_9.xmp'), KEPT_XMP);
    await mkdir(abs('.maple', 'trash'), { recursive: true });
    await symlink(outside, abs('.maple', 'trash', 'escape'));
    trashedRowAt('.maple/trash/escape', 'IMG_9.dng');

    const summary = await runTrashGcOnce({ retentionDays: 30 });

    expect(summary.errors).toBeGreaterThan(0);
    expect(await readFile(path.join(outside, 'IMG_9.dng'), 'utf8')).toBe(KEPT_RAW);
    expect(await readFile(path.join(outside, 'IMG_9.xmp'), 'utf8')).toBe(KEPT_XMP);
  });

  it('removes only the link when the trashed file itself is a symlink out of the library', async () => {
    await write(path.join(outside, 'IMG_9.dng'), KEPT_RAW);
    await mkdir(abs('.maple', 'trash', 'linked'), { recursive: true });
    await symlink(path.join(outside, 'IMG_9.dng'), abs('.maple', 'trash', 'linked', 'IMG_9.dng'));
    trashedRowAt('.maple/trash/linked', 'IMG_9.dng');

    expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({
      scanned: 1,
      purged: 1,
      errors: 0,
    });

    expect(await lstat(abs('.maple', 'trash', 'linked', 'IMG_9.dng')).catch(() => null)).toBeNull();
    expect(await readFile(path.join(outside, 'IMG_9.dng'), 'utf8')).toBe(KEPT_RAW);
  });
});
