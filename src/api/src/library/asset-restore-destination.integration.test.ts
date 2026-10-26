/**
 * #5425: the catalog rows a Trash restore may clear at its destination. The
 * photo's own stale location merges, a watcher duplicate of the same content
 * with nothing of its own goes, and any other photo's row survives untouched
 * while the restore takes another name. Real library directories, the real
 * trash action and route, and one real SQLite database.
 */

import { expect, spyOn, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as path from 'node:path';
import { mkdir, readFile, stat, writeFile } from '../fs/mirrored.ts';
import { ObjectId } from '../db/object-id.ts';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers.ts';
import {
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import * as assetsRepo from '../db/repos/assets.repo.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { trashRoutes } from '../routes/assets/trash.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { trashAssetById } from './asset-trash.ts';

const RAW = 'restore-destination-raw-bytes';
const HEAD = 'sha1-head-of-the-photo';

/** One photo at `photos/IMG_1.dng` with an XMP edit, trashed through the real
 * trash action. */
async function fixture() {
  const f = await recoveryFixture();
  const library = path.join(f.root, 'library');
  await mkdir(path.join(library, 'photos'), { recursive: true });
  await writeFile(path.join(library, 'photos', 'IMG_1.dng'), RAW);
  await writeFile(path.join(library, 'photos', 'IMG_1.xmp'), '<x:xmpmeta>edit</x:xmpmeta>');

  const libraryId = insertFolder(f.live.db, { path: library });
  invalidateLibraryRoots();
  const id = insertAsset(f.live.db);
  run(f.live.db, `UPDATE assets SET sha1_head = ?, size = ? WHERE id = ?`, HEAD, RAW.length, id);
  insertLocation(f.live.db, { assetId: id, libraryId, path: 'photos', filename: 'IMG_1.dng' });
  const trashed = await trashAssetById(new ObjectId(id), {
    entry: { libraryId: new ObjectId(libraryId), path: 'photos', filename: 'IMG_1.dng' },
  });
  expect(trashed.kind).toBe('ok');

  const app = new Elysia().use(fakeAuth()).group('/api/assets', (g) => g.use(trashRoutes));
  const rows = (sql: string, ...params: string[]) => f.live.db.query(sql).all(...params);
  return {
    ...f,
    library,
    libraryId,
    id,
    trashedRaw: path.join(library, '.maple', 'trash', 'photos', 'IMG_1.dng'),
    restore: () =>
      app.handle(
        new Request(`http://localhost/api/assets/${id}/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      ),
    locations: (assetId = id) =>
      rows(
        `SELECT ordinal, path, filename, missing_since FROM asset_locations
          WHERE asset_id = ? ORDER BY ordinal`,
        assetId,
      ),
    deletedAt: () =>
      (
        f.live.db.query(`SELECT deleted_at FROM assets WHERE id = ?`).get(id) as {
          deleted_at: string | null;
        }
      ).deleted_at,
    /** Every row another photo owns, to compare after the restore. */
    rowsOf: (assetId: string) =>
      Object.fromEntries(
        ['assets', 'asset_locations', 'faces', 'asset_detail', 'sidecar_divergences'].map(
          (table) => [
            table,
            rows(
              `SELECT * FROM ${table} WHERE ${table === 'assets' ? 'id' : 'asset_id'} = ?`,
              assetId,
            ),
          ],
        ),
      ),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const exists = (target: string) =>
  stat(target).then(
    () => true,
    () => false,
  );

/** Another photo's catalog row at the restore destination, with a face, a
 * description and an edit-history entry of its own. */
function insertOtherPhoto(f: Fixture, sha1Head: string): string {
  const other = insertAsset(f.live.db);
  run(
    f.live.db,
    `UPDATE assets SET sha1_head = ?, size = ? WHERE id = ?`,
    sha1Head,
    RAW.length,
    other,
  );
  insertLocation(f.live.db, {
    assetId: other,
    libraryId: f.libraryId,
    path: 'photos',
    filename: 'IMG_1.dng',
  });
  run(
    f.live.db,
    `INSERT INTO faces (asset_id, face_index, confidence, bbox_x, bbox_y, bbox_w, bbox_h)
     VALUES (?, 0, 0.9, 0.1, 0.1, 0.2, 0.2)`,
    other,
  );
  run(
    f.live.db,
    `INSERT INTO asset_detail (asset_id, description) VALUES (?, 'Grandma at the lake')`,
    other,
  );
  run(
    f.live.db,
    `INSERT INTO sidecar_divergences (id, asset_id, library_id, sidecar_rel_path, device_id,
       displaced_sha256, displaced_xmp, incoming_sha256, created_at)
     VALUES (?, ?, ?, 'photos/IMG_1.xmp', 'device', 'old', '<x/>', 'new', '2026-10-01T00:00:00Z')`,
    new ObjectId().toHexString(),
    other,
    f.libraryId,
  );
  return other;
}

async function expectRestoredBesideOther(f: Fixture, response: Response) {
  expect(response.status).toBe(200);
  const restoredRaw = path.join(f.library, 'photos', 'IMG_1.restored.dng');
  expect(((await response.json()) as { abs_path: string }).abs_path).toBe(restoredRaw);
  expect(await readFile(restoredRaw, 'utf8')).toBe(RAW);
  expect(await readFile(path.join(f.library, 'photos', 'IMG_1.restored.xmp'), 'utf8')).toBe(
    '<x:xmpmeta>edit</x:xmpmeta>',
  );
  expect(await exists(path.join(f.library, 'photos', 'IMG_1.dng'))).toBe(false);
  expect(await exists(f.trashedRaw)).toBe(false);
  expect(f.deletedAt()).toBeNull();
}

test("a restore merges the photo's own stale row at the destination and completes", async () => {
  const f = await fixture();
  try {
    insertLocation(f.live.db, {
      assetId: f.id,
      libraryId: f.libraryId,
      ordinal: 1,
      path: 'photos',
      filename: 'IMG_1.dng',
      missingSince: '2026-10-01T00:00:00Z',
    });

    const response = await f.restore();

    expect(response.status).toBe(200);
    expect(await readFile(path.join(f.library, 'photos', 'IMG_1.dng'), 'utf8')).toBe(RAW);
    expect(await exists(f.trashedRaw)).toBe(false);
    expect(f.deletedAt()).toBeNull();
    expect(f.locations()).toEqual([
      { ordinal: 0, path: 'photos', filename: 'IMG_1.dng', missing_since: null },
    ]);
  } finally {
    await f.close();
  }
});

test('a watcher duplicate of the same content with no data of its own is removed', async () => {
  const f = await fixture();
  try {
    const watcher = insertAsset(f.live.db);
    run(
      f.live.db,
      `UPDATE assets SET sha1_head = ?, size = ? WHERE id = ?`,
      HEAD,
      RAW.length,
      watcher,
    );
    insertLocation(f.live.db, {
      assetId: watcher,
      libraryId: f.libraryId,
      path: 'photos',
      filename: 'IMG_1.dng',
    });

    const response = await f.restore();

    expect(response.status).toBe(200);
    expect(await readFile(path.join(f.library, 'photos', 'IMG_1.dng'), 'utf8')).toBe(RAW);
    expect(f.rowsOf(watcher).assets).toEqual([]);
    expect(f.locations()).toEqual([
      { ordinal: 0, path: 'photos', filename: 'IMG_1.dng', missing_since: null },
    ]);
  } finally {
    await f.close();
  }
});

test('a same-content row with data of its own is kept and the restore takes another name', async () => {
  const f = await fixture();
  try {
    const other = insertOtherPhoto(f, HEAD);
    const before = f.rowsOf(other);

    await expectRestoredBesideOther(f, await f.restore());

    expect(f.rowsOf(other)).toEqual(before);
    expect(f.locations()).toEqual([
      { ordinal: 0, path: 'photos', filename: 'IMG_1.restored.dng', missing_since: null },
    ]);
  } finally {
    await f.close();
  }
});

test('a same-content row with a missing location and its own rating is kept', async () => {
  const f = await fixture();
  try {
    const other = insertAsset(f.live.db);
    run(
      f.live.db,
      `UPDATE assets SET sha1_head = ?, size = ?, rating = 5 WHERE id = ?`,
      HEAD,
      RAW.length,
      other,
    );
    insertLocation(f.live.db, {
      assetId: other,
      libraryId: f.libraryId,
      path: 'photos',
      filename: 'IMG_1.dng',
      missingSince: '2026-10-01T00:00:00Z',
    });
    const before = f.rowsOf(other);

    await expectRestoredBesideOther(f, await f.restore());

    expect(f.rowsOf(other)).toEqual(before);
  } finally {
    await f.close();
  }
});

test("another photo's row at the destination survives the restore untouched", async () => {
  const f = await fixture();
  try {
    const other = insertOtherPhoto(f, 'sha1-head-of-a-different-photo');
    const before = f.rowsOf(other);

    await expectRestoredBesideOther(f, await f.restore());

    expect(f.rowsOf(other)).toEqual(before);
  } finally {
    await f.close();
  }
});

test("another photo's row claiming the destination mid-restore is kept, and the photo stays in Trash", async () => {
  const f = await fixture();
  const claimed = assetsRepo.restoreDestinationClaimed;
  const spy = spyOn(assetsRepo, 'restoreDestinationClaimed');
  try {
    let other: string | null = null;
    let before: ReturnType<Fixture['rowsOf']> | null = null;
    spy.mockImplementation(async (...args) => {
      const result = await claimed(...args);
      if (other === null) {
        other = insertOtherPhoto(f, 'sha1-head-of-a-different-photo');
        before = f.rowsOf(other);
      }
      return result;
    });

    const response = await f.restore();

    expect(response.status).toBe(500);
    expect(await readFile(f.trashedRaw, 'utf8')).toBe(RAW);
    expect(await exists(path.join(f.library, 'photos', 'IMG_1.dng'))).toBe(false);
    expect(f.deletedAt()).not.toBeNull();
    expect(await readFile(path.join(path.dirname(f.trashedRaw), 'IMG_1.xmp'), 'utf8')).toBe(
      '<x:xmpmeta>edit</x:xmpmeta>',
    );
    expect(f.rowsOf(other!)).toEqual(before!);
  } finally {
    spy.mockRestore();
    await f.close();
  }
});
