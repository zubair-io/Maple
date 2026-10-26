/**
 * #5405: a Trash restore moves only the copy the trash action put inside
 * `.maple/trash/`, back to its recorded original path. A second copy of the
 * photo stays where it is, byte for byte. Real library and folder-mirror
 * directories, the real trash action and route, and one real SQLite database.
 */

import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as path from 'node:path';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from '../fs/mirrored.ts';
import { ObjectId } from '../db/object-id.ts';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers.ts';
import {
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { backupEngine } from '../cloud-backup/runtime.ts';
import { trashRoutes } from '../routes/assets/trash.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { restoreAssetById, trashAssetById } from './asset-trash.ts';
import { restoreFolderRecursive } from './folder-trash.ts';

const RAW = 'restore-raw-bytes';

/** `copies` in location order, each with a RAW and its own XMP edit;
 * `copies[trashedIndex]` is trashed through the real trash action. */
async function fixture(copies: readonly string[], trashedIndex: number) {
  const f = await recoveryFixture();
  const library = path.join(f.root, 'library');
  const mirror = path.join(f.root, 'mirror');
  for (const dir of copies) {
    await mkdir(path.join(library, dir), { recursive: true });
    await writeFile(path.join(library, dir, 'IMG_1.dng'), `${RAW}:${dir}`);
    await writeFile(path.join(library, dir, 'IMG_1.xmp'), `<x:xmpmeta>${dir} edit</x:xmpmeta>`);
    await mkdir(path.join(mirror, dir), { recursive: true });
    await copyFile(path.join(library, dir, 'IMG_1.dng'), path.join(mirror, dir, 'IMG_1.dng'));
  }

  const libraryId = insertFolder(f.live.db, { path: library });
  invalidateLibraryRoots();
  const id = insertAsset(f.live.db);
  copies.forEach((dir, ordinal) =>
    insertLocation(f.live.db, {
      assetId: id,
      libraryId,
      ordinal,
      path: dir,
      filename: 'IMG_1.dng',
    }),
  );
  const destination = await backupEngine.repo.createDestination({
    libraryId,
    kind: 'folder',
    name: 'Photo mirror',
    path: mirror,
  });
  for (const [ordinal, dir] of copies.entries())
    await backupEngine.repo.ensureEntry(destination.id, id, ordinal, `${dir}/IMG_1.dng`);

  const trashedDir = copies[trashedIndex]!;
  const trashed = await trashAssetById(new ObjectId(id), {
    entry: { libraryId: new ObjectId(libraryId), path: trashedDir, filename: 'IMG_1.dng' },
  });
  expect(trashed.kind).toBe('ok');

  const app = new Elysia().use(fakeAuth()).group('/api/assets', (g) => g.use(trashRoutes));
  return {
    ...f,
    library,
    libraryId,
    id,
    destination,
    trashedDir,
    trashedRaw: path.join(library, '.maple', 'trash', trashedDir, 'IMG_1.dng'),
    restore: () =>
      app.handle(
        new Request(`http://localhost/api/assets/${id}/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      ),
    locations: () =>
      f.live.db
        .query(`SELECT ordinal, path FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`)
        .all(id),
    deletedAt: () =>
      (
        f.live.db.query(`SELECT deleted_at FROM assets WHERE id = ?`).get(id) as {
          deleted_at: string | null;
        }
      ).deleted_at,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const exists = (target: string) =>
  stat(target).then(
    () => true,
    () => false,
  );

/** The untouched copy's bytes and identity, to compare after the restore. */
async function snapshot(f: Fixture, dir: string) {
  const raw = path.join(f.library, dir, 'IMG_1.dng');
  const st = await stat(raw, { bigint: true });
  return {
    raw: await readFile(raw, 'utf8'),
    xmp: await readFile(path.join(f.library, dir, 'IMG_1.xmp'), 'utf8'),
    ino: st.ino,
    mtimeNs: st.mtimeNs,
  };
}

async function expectStillTrashed(f: Fixture, keptBefore: Awaited<ReturnType<typeof snapshot>>) {
  expect(await snapshot(f, 'kept')).toEqual(keptBefore);
  expect(await readFile(f.trashedRaw, 'utf8')).toBe(`${RAW}:${f.trashedDir}`);
  expect(await exists(path.join(f.library, f.trashedDir, 'IMG_1.dng'))).toBe(false);
  expect(f.deletedAt()).not.toBeNull();
}

test('restoring one trashed copy moves it back and leaves the other copy untouched', async () => {
  const f = await fixture(['kept', 'dupe'], 1);
  try {
    const keptBefore = await snapshot(f, 'kept');

    const response = await f.restore();

    expect(response.status).toBe(200);
    const restoredRaw = path.join(f.library, 'dupe', 'IMG_1.dng');
    expect(((await response.json()) as { abs_path: string }).abs_path).toBe(restoredRaw);
    expect(await snapshot(f, 'kept')).toEqual(keptBefore);
    expect(await readFile(restoredRaw, 'utf8')).toBe(`${RAW}:dupe`);
    expect(await readFile(path.join(f.library, 'dupe', 'IMG_1.xmp'), 'utf8')).toBe(
      '<x:xmpmeta>dupe edit</x:xmpmeta>',
    );
    expect(await exists(f.trashedRaw)).toBe(false);
    expect(f.deletedAt()).toBeNull();
    expect(f.locations()).toEqual([
      { ordinal: 0, path: 'kept' },
      { ordinal: 1, path: 'dupe' },
    ]);
    const entries = await backupEngine.repo.entries(f.destination.id, f.id);
    expect(
      entries
        .map((entry) => [entry.ordinal, entry.source_path, entry.state === 'purged'])
        .sort(([a], [b]) => Number(a) - Number(b)),
    ).toEqual([
      [0, 'kept/IMG_1.dng', false],
      [1, 'dupe/IMG_1.dng', false],
    ]);
  } finally {
    await f.close();
  }
});

test('a restore gives ordinal 0 to the lowest surviving copy when no location held it', async () => {
  const f = await fixture(['kept', 'dupe'], 1);
  try {
    for (const table of ['asset_locations', 'backup_entries']) {
      run(f.live.db, `UPDATE ${table} SET ordinal = 2 WHERE asset_id = ? AND ordinal = 1`, f.id);
      run(f.live.db, `UPDATE ${table} SET ordinal = 1 WHERE asset_id = ? AND ordinal = 0`, f.id);
    }

    expect((await f.restore()).status).toBe(200);

    expect(f.locations()).toEqual([
      { ordinal: 0, path: 'kept' },
      { ordinal: 2, path: 'dupe' },
    ]);
    const entries = await backupEngine.repo.entries(f.destination.id, f.id);
    expect(entries.find((entry) => entry.ordinal === 0)?.source_path).toBe('kept/IMG_1.dng');
  } finally {
    await f.close();
  }
});

test('a single-copy photo restores to its original path', async () => {
  const f = await fixture(['only'], 0);
  try {
    const response = await f.restore();

    expect(response.status).toBe(200);
    expect(await readFile(path.join(f.library, 'only', 'IMG_1.dng'), 'utf8')).toBe(`${RAW}:only`);
    expect(await exists(f.trashedRaw)).toBe(false);
    expect(f.deletedAt()).toBeNull();
    expect(f.locations()).toEqual([{ ordinal: 0, path: 'only' }]);
  } finally {
    await f.close();
  }
});

test('a caller-named location outside Trash is refused and nothing moves', async () => {
  const f = await fixture(['kept', 'dupe'], 1);
  try {
    const keptBefore = await snapshot(f, 'kept');

    const outcome = await restoreAssetById(new ObjectId(f.id), {
      entry: { libraryId: new ObjectId(f.libraryId), path: 'kept', filename: 'IMG_1.dng' },
    });

    expect(outcome.kind).toBe('not-in-trash');
    await expectStillTrashed(f, keptBefore);
  } finally {
    await f.close();
  }
});

test('a folder restore moves the trashed copy, not another copy in the same library', async () => {
  const f = await fixture(['kept', 'dupe'], 1);
  try {
    const keptBefore = await snapshot(f, 'kept');

    const summary = await restoreFolderRecursive(new ObjectId(f.libraryId), f.library, 'dupe');

    expect(summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
    expect(await snapshot(f, 'kept')).toEqual(keptBefore);
    expect(await readFile(path.join(f.library, 'dupe', 'IMG_1.dng'), 'utf8')).toBe(`${RAW}:dupe`);
    expect(await exists(f.trashedRaw)).toBe(false);
  } finally {
    await f.close();
  }
});

test('a restore into a .mapleignore folder is refused', async () => {
  const f = await fixture(['kept', 'dupe'], 1);
  try {
    const keptBefore = await snapshot(f, 'kept');
    await mkdir(path.join(f.library, 'dupe'), { recursive: true });
    await writeFile(path.join(f.library, 'dupe', '.mapleignore'), '');

    const response = await f.restore();

    expect(response.status).toBe(409);
    await expectStillTrashed(f, keptBefore);
  } finally {
    await f.close();
  }
});

test('a restore while the library is unreachable answers 503 and moves nothing', async () => {
  const f = await fixture(['kept', 'dupe'], 1);
  const offline = `${f.library}-offline`;
  try {
    const keptBefore = await snapshot(f, 'kept');
    await rename(f.library, offline);

    const response = await f.restore();

    expect(response.status).toBe(503);
    await rename(offline, f.library);
    await expectStillTrashed(f, keptBefore);
  } finally {
    if (await exists(offline)) await rename(offline, f.library);
    await f.close();
  }
});
