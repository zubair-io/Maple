/**
 * #5403 option B: purging a trashed copy while another copy of the photo
 * survives keeps the photo, its row data and the surviving copy's backups.
 * Real library and folder-mirror directories, the real trash action, the real
 * backup purge drain, and one real SQLite database.
 */

import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as path from 'node:path';
import { copyFile, mkdir, readFile, stat, writeFile } from '../fs/mirrored.ts';
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
import { drainPurges } from '../cloud-backup/purge.ts';
import { trashRoutes } from '../routes/assets/trash.ts';
import { runTrashGcOnce } from '../workers/trash-gc.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { trashAssetById } from './asset-trash.ts';
import { chmod } from '../fs/mirrored.ts';
import { keepSurvivingCopy } from '../db/repos/assets.trash-survivor.ts';
import { capturedTrashPurge } from '../cloud-backup/trash-purge-admission.ts';
import { findCoreInfoById } from '../db/repos/assets.repo.ts';
import { drainLocalPurges } from './local-purge-drain.ts';
import { fileStampOf } from './trashed-copy.ts';
import { rename, rm } from '../fs/mirrored.ts';
import { searchFacets } from '../db/repos/search.facets.ts';
import { searchPage } from '../db/repos/search.page.ts';
import { buildSearchWhere, type SearchWhere } from '../db/repos/search.where.ts';

function everything(): SearchWhere {
  const built = buildSearchWhere({});
  if ('error' in built) throw new Error(built.error);
  return built;
}

type Mode = 'route' | 'retention';

const RAW = 'kept-raw-bytes';
const COMPANION = 'kept/IMG_E1.jpg';
const OLD = '2000-01-01T00:00:00.000Z';

/** `copies` in location order; `copies[trashedIndex]` is trashed (by default the primary). */
async function fixture(copies: readonly string[], trashedIndex = 0) {
  const f = await recoveryFixture();
  const library = path.join(f.root, 'library');
  const mirror = path.join(f.root, 'mirror');
  const mirrorOf = (target: string) => path.join(mirror, path.relative(library, target));
  const backUp = async (target: string) => {
    await mkdir(path.dirname(mirrorOf(target)), { recursive: true });
    await copyFile(target, mirrorOf(target));
  };
  for (const dir of copies) {
    await mkdir(path.join(library, dir), { recursive: true });
    await writeFile(path.join(library, dir, 'IMG_1.dng'), RAW);
    await writeFile(path.join(library, dir, 'IMG_1.xmp'), `<x:xmpmeta>${dir} edit</x:xmpmeta>`);
  }
  await mkdir(path.join(library, 'kept'), { recursive: true });
  await writeFile(path.join(library, COMPANION), 'rendered-edit');
  for (const target of [
    path.join(library, COMPANION),
    ...copies.flatMap((dir) => ['IMG_1.dng', 'IMG_1.xmp'].map((n) => path.join(library, dir, n))),
  ])
    await backUp(target);

  const libraryId = insertFolder(f.live.db, { path: library });
  invalidateLibraryRoots();
  const id = insertAsset(f.live.db);
  run(
    f.live.db,
    `UPDATE assets SET size = ?, rating = 4, apple_rendered_path = ? WHERE id = ?`,
    RAW.length,
    COMPANION,
    id,
  );
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
  const outcome = await trashAssetById(new ObjectId(id), {
    entry: { libraryId: new ObjectId(libraryId), path: trashedDir, filename: 'IMG_1.dng' },
  });
  expect(outcome.kind).toBe('ok');
  run(f.live.db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, OLD, id);
  const trashedRaw = path.join(library, '.maple', 'trash', trashedDir, 'IMG_1.dng');
  const trashedXmp = path.join(library, '.maple', 'trash', trashedDir, 'IMG_1.xmp');
  for (const target of [trashedRaw, trashedXmp]) await backUp(target);

  const app = new Elysia().use(fakeAuth()).group('/api/assets', (g) => g.use(trashRoutes));
  return {
    ...f,
    library,
    mirror,
    mirrorOf,
    id,
    destination,
    trashedRaw,
    trashedXmp,
    purge(mode: Mode) {
      return mode === 'route'
        ? app.handle(
            new Request(`http://localhost/api/assets/${id}?intent=purge`, { method: 'DELETE' }),
          )
        : runTrashGcOnce({ retentionDays: 30 });
    },
  };
}

const gone = (target: string) =>
  stat(target).then(
    () => false,
    () => true,
  );

test.each(['route', 'retention'] as const)(
  '%s purge of one trashed copy keeps the photo, its row data and its backups',
  async (mode) => {
    const f = await fixture(['dupe', 'kept']);
    const keptRaw = path.join(f.library, 'kept', 'IMG_1.dng');
    const keptXmp = path.join(f.library, 'kept', 'IMG_1.xmp');
    const keptCompanion = path.join(f.library, COMPANION);
    try {
      const outcome = await f.purge(mode);

      if (outcome instanceof Response) {
        expect(outcome.status).toBe(200);
        expect(await outcome.json()).toEqual({
          asset_id: f.id,
          state: 'live',
          abs_path: keptRaw,
          cleanup: 'done',
        });
      } else expect(outcome).toEqual({ scanned: 1, purged: 1, errors: 0 });

      expect(await readFile(keptRaw, 'utf8')).toBe(RAW);
      expect(await readFile(keptXmp, 'utf8')).toBe('<x:xmpmeta>kept edit</x:xmpmeta>');
      expect(await readFile(keptCompanion, 'utf8')).toBe('rendered-edit');
      expect(await gone(f.trashedRaw)).toBe(true);
      expect(await gone(f.trashedXmp)).toBe(true);

      expect(
        f.live.db
          .query(
            `SELECT deleted_at, deleted_reason, original_path, rating, apple_rendered_path
               FROM assets WHERE id = ?`,
          )
          .get(f.id),
      ).toEqual({
        deleted_at: null,
        deleted_reason: null,
        original_path: null,
        rating: 4,
        apple_rendered_path: COMPANION,
      });
      expect(
        f.live.db.query(`SELECT ordinal, path FROM asset_locations WHERE asset_id = ?`).all(f.id),
      ).toEqual([{ ordinal: 0, path: 'kept' }]);
      expect(
        f.live.db
          .query(`SELECT version FROM stage_state WHERE asset_id = ? AND stage = 'thumb'`)
          .get(f.id),
      ).toEqual({ version: 0 });
      expect(
        f.live.db
          .query(`SELECT kind FROM asset_changes WHERE asset_id = ? ORDER BY cursor DESC LIMIT 1`)
          .get(f.id),
      ).toEqual({ kind: 'restore' });

      expect(
        f.live.db.query(`SELECT COUNT(*) AS n FROM backup_lifecycle WHERE kind = 'purge'`).get(),
      ).toEqual({ n: 0 });
      const entries = await backupEngine.repo.entries(f.destination.id, f.id);
      expect(
        entries
          .map((entry) => [entry.ordinal, entry.source_path, entry.state === 'purged'])
          .sort(([a], [b]) => Number(a) - Number(b)),
      ).toEqual([
        [0, 'kept/IMG_1.dng', false],
        [2, '.maple/trash/dupe/IMG_1.dng', true],
      ]);
      await drainPurges(backupEngine, f.destination);
      expect(f.live.db.query(`SELECT completed FROM backup_purges`).all()).toEqual([
        { completed: 1 },
      ]);
      expect(await gone(f.mirrorOf(f.trashedRaw))).toBe(true);
      expect(await gone(f.mirrorOf(f.trashedXmp))).toBe(true);
      expect(await readFile(f.mirrorOf(keptRaw), 'utf8')).toBe(RAW);
      expect(await readFile(f.mirrorOf(keptXmp), 'utf8')).toBe('<x:xmpmeta>kept edit</x:xmpmeta>');
      expect(await readFile(f.mirrorOf(keptCompanion), 'utf8')).toBe('rendered-edit');
    } finally {
      await f.close();
    }
  },
);

test.each(['route', 'retention'] as const)(
  '%s purge of a single-copy photo still erases the row and all its backups',
  async (mode) => {
    const f = await fixture(['solo']);
    try {
      const outcome = await f.purge(mode);

      if (outcome instanceof Response) expect(outcome.status).toBe(204);
      else expect(outcome).toEqual({ scanned: 1, purged: 1, errors: 0 });
      expect(await gone(f.trashedRaw)).toBe(true);
      expect(f.live.db.query(`SELECT id FROM assets WHERE id = ?`).get(f.id)).toBeNull();
      expect(
        f.live.db.query(`SELECT COUNT(*) AS n FROM backup_lifecycle WHERE kind = 'purge'`).get(),
      ).toEqual({ n: 1 });
      await drainPurges(backupEngine, f.destination);
      expect(await gone(f.mirrorOf(f.trashedRaw))).toBe(true);
    } finally {
      await f.close();
    }
  },
);

test('a kept photo whose trashed copy was canonical stays in the name sort and the extension facet', async () => {
  const f = await fixture(['dupe', 'kept']);
  try {
    const other = insertAsset(f.live.db);
    const libraryId = (f.live.db.query(`SELECT id FROM folders`).get() as { id: string }).id;
    insertLocation(f.live.db, {
      assetId: other,
      libraryId,
      path: 'other',
      filename: 'A_other.dng',
    });

    await f.purge('retention');

    const page = await searchPage(everything(), { sort: 'name', limit: 20, skip: 0 });
    expect(page.map((row) => row.fileinfo?.[0]?.filename)).toEqual(['A_other.dng', 'IMG_1.dng']);
    const { extensions } = await searchFacets(everything());
    expect(extensions).toContainEqual({ value: 'dng', count: 2 });
  } finally {
    await f.close();
  }
});

test('companions of a canonical trashed copy in another library leave with it, and nothing in the survivor library is touched', async () => {
  const f = await recoveryFixture();
  try {
    const libraryA = path.join(f.root, 'a');
    const libraryB = path.join(f.root, 'b');
    for (const [root, dir] of [
      [libraryA, 'dupe'],
      [libraryB, 'kept'],
    ] as const) {
      await mkdir(path.join(root, dir), { recursive: true });
      await writeFile(path.join(root, dir, 'IMG_1.dng'), RAW);
      await writeFile(path.join(root, dir, 'IMG_1.xmp'), `<x:xmpmeta>${dir}</x:xmpmeta>`);
    }
    await writeFile(path.join(libraryA, 'dupe', 'IMG_E1.jpg'), 'rendered-edit');
    await writeFile(path.join(libraryA, 'dupe', 'IMG_1.mov'), 'live-video');
    await mkdir(path.join(libraryB, 'dupe'), { recursive: true });
    await writeFile(path.join(libraryB, 'dupe', 'IMG_E1.jpg'), 'unrelated-b-file');
    const idA = insertFolder(f.live.db, { path: libraryA, slug: 'a' });
    const idB = insertFolder(f.live.db, { path: libraryB, slug: 'b' });
    invalidateLibraryRoots();
    const id = insertAsset(f.live.db);
    run(
      f.live.db,
      `UPDATE assets SET size = ?, apple_rendered_path = ?, apple_live_video_path = ? WHERE id = ?`,
      RAW.length,
      'dupe/IMG_E1.jpg',
      'dupe/IMG_1.mov',
      id,
    );
    insertLocation(f.live.db, {
      assetId: id,
      libraryId: idA,
      ordinal: 0,
      path: 'dupe',
      filename: 'IMG_1.dng',
    });
    insertLocation(f.live.db, {
      assetId: id,
      libraryId: idB,
      ordinal: 1,
      path: 'kept',
      filename: 'IMG_1.dng',
    });
    const trashed = await trashAssetById(new ObjectId(id), {
      entry: { libraryId: new ObjectId(idA), path: 'dupe', filename: 'IMG_1.dng' },
    });
    expect(trashed.kind).toBe('ok');
    run(f.live.db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, OLD, id);

    expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({
      scanned: 1,
      purged: 1,
      errors: 0,
    });

    expect(await gone(path.join(libraryA, '.maple', 'trash', 'dupe', 'IMG_1.dng'))).toBe(true);
    expect(await gone(path.join(libraryA, 'dupe', 'IMG_E1.jpg'))).toBe(true);
    expect(await gone(path.join(libraryA, 'dupe', 'IMG_1.mov'))).toBe(true);
    expect(await readFile(path.join(libraryB, 'kept', 'IMG_1.dng'), 'utf8')).toBe(RAW);
    expect(await readFile(path.join(libraryB, 'kept', 'IMG_1.xmp'), 'utf8')).toBe(
      '<x:xmpmeta>kept</x:xmpmeta>',
    );
    expect(await readFile(path.join(libraryB, 'dupe', 'IMG_E1.jpg'), 'utf8')).toBe(
      'unrelated-b-file',
    );
    expect(
      f.live.db
        .query(
          `SELECT deleted_at, apple_rendered_path, apple_live_video_path FROM assets WHERE id = ?`,
        )
        .get(id),
    ).toEqual({ deleted_at: null, apple_rendered_path: null, apple_live_video_path: null });
    expect(
      f.live.db.query(`SELECT ordinal, library_id FROM asset_locations WHERE asset_id = ?`).all(id),
    ).toEqual([{ ordinal: 0, library_id: idB }]);
  } finally {
    await f.close();
  }
});

function obligations(db: { query: (sql: string) => { all: () => unknown[] } }) {
  return db.query(`SELECT rel_path, kind FROM local_purge_obligations ORDER BY rel_path`).all();
}

test.skipIf(process.getuid?.() === 0)(
  'a failed unlink stays owed and a later drain removes the trashed copy',
  async () => {
    const f = await fixture(['dupe', 'kept']);
    const trashDir = path.dirname(f.trashedRaw);
    try {
      await chmod(trashDir, 0o555);
      const res = (await f.purge('route')) as Response;

      expect(res.status).toBe(200);
      expect(((await res.json()) as { cleanup: string }).cleanup).toBe('pending');
      expect(await readFile(f.trashedRaw, 'utf8')).toBe(RAW);
      expect(obligations(f.live.db)).toEqual([
        { rel_path: '.maple/trash/dupe/IMG_1.dng', kind: 'trash' },
        { rel_path: '.maple/trash/dupe/IMG_1.xmp', kind: 'trash' },
      ]);

      await chmod(trashDir, 0o755);
      expect(await drainLocalPurges({ now: Date.now() + 3_600_000 })).toEqual({
        done: 2,
        pending: 0,
      });
      expect(await gone(f.trashedRaw)).toBe(true);
      expect(await gone(f.trashedXmp)).toBe(true);
      expect(obligations(f.live.db)).toEqual([]);
      expect(await readFile(path.join(f.library, 'kept', 'IMG_1.dng'), 'utf8')).toBe(RAW);
    } finally {
      await chmod(trashDir, 0o755).catch(() => {});
      await f.close();
    }
  },
);

test('a crash after the photo is kept leaves the cleanup owed, and the next sweep finishes it', async () => {
  const f = await fixture(['dupe', 'kept']);
  try {
    const info = (await findCoreInfoById(new ObjectId(f.id)))!;
    const libraryId = (f.live.db.query(`SELECT id FROM folders`).get() as { id: string }).id;
    const owner = '.maple/trash/dupe/IMG_1.dng';
    const kept = await keepSurvivingCopy({
      id: new ObjectId(f.id),
      trashed: {
        libraryId: new ObjectId(libraryId),
        path: '.maple/trash/dupe',
        filename: 'IMG_1.dng',
      },
      expected: capturedTrashPurge(info),
      dropCompanions: false,
      cleanup: [
        {
          relPath: owner,
          ownerRelPath: owner,
          kind: 'trash',
          stamp: (await fileStampOf(f.trashedRaw))!,
        },
        {
          relPath: '.maple/trash/dupe/IMG_1.xmp',
          ownerRelPath: owner,
          kind: 'trash',
          stamp: (await fileStampOf(f.trashedXmp))!,
        },
      ],
    });
    expect(kept).toEqual({ kind: 'kept', erasedBackups: 0 });
    expect(await readFile(f.trashedRaw, 'utf8')).toBe(RAW);

    await runTrashGcOnce({ retentionDays: 30 });

    expect(await gone(f.trashedRaw)).toBe(true);
    expect(await gone(f.trashedXmp)).toBe(true);
    expect(obligations(f.live.db)).toEqual([]);
    expect(f.live.db.query(`SELECT deleted_at FROM assets WHERE id = ?`).get(f.id)).toEqual({
      deleted_at: null,
    });
  } finally {
    await f.close();
  }
});

test('a kept purge survives an earlier removal that left ordinal 0 empty with a stale backup entry', async () => {
  const f = await fixture(['gone', 'dupe', 'kept'], 1);
  try {
    run(f.live.db, `DELETE FROM asset_locations WHERE asset_id = ? AND path = 'gone'`, f.id);
    await rm(path.join(f.library, 'gone'), { recursive: true });

    expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({
      scanned: 1,
      purged: 1,
      errors: 0,
    });

    expect(
      f.live.db.query(`SELECT ordinal, path FROM asset_locations WHERE asset_id = ?`).all(f.id),
    ).toEqual([{ ordinal: 0, path: 'kept' }]);
    const entries = await backupEngine.repo.entries(f.destination.id, f.id);
    const byOrdinal = Object.fromEntries(entries.map((entry) => [entry.ordinal, entry]));
    expect(byOrdinal[0]!.source_path).toBe('kept/IMG_1.dng');
    expect(byOrdinal[0]!.state).not.toBe('purged');
    expect(entries.filter((entry) => entry.source_path === 'gone/IMG_1.dng')).toHaveLength(1);
    expect(await readFile(path.join(f.library, 'kept', 'IMG_1.dng'), 'utf8')).toBe(RAW);
  } finally {
    await f.close();
  }
});

test('a kept purge leaves an XMP that another trashed photo shares', async () => {
  const f = await fixture(['dupe', 'kept']);
  try {
    const otherJpg = path.join(path.dirname(f.trashedRaw), 'IMG_1.jpg');
    await writeFile(otherJpg, 'other-photo');
    const other = insertAsset(f.live.db, { deletedAt: new Date().toISOString() });
    const libraryId = (f.live.db.query(`SELECT id FROM folders`).get() as { id: string }).id;
    insertLocation(f.live.db, {
      assetId: other,
      libraryId,
      path: '.maple/trash/dupe',
      filename: 'IMG_1.jpg',
    });

    const res = (await f.purge('route')) as Response;

    expect(res.status).toBe(200);
    expect(await gone(f.trashedRaw)).toBe(true);
    expect(await readFile(f.trashedXmp, 'utf8')).toBe('<x:xmpmeta>dupe edit</x:xmpmeta>');
    expect(await readFile(otherJpg, 'utf8')).toBe('other-photo');
  } finally {
    await f.close();
  }
});

test.skipIf(process.getuid?.() === 0)(
  'an owed unlink never removes a different file that later took the same Trash path',
  async () => {
    const f = await fixture(['dupe', 'kept']);
    const trashDir = path.dirname(f.trashedRaw);
    try {
      await chmod(trashDir, 0o555);
      expect(
        ((await ((await f.purge('route')) as Response).json()) as { cleanup: string }).cleanup,
      ).toBe('pending');
      await chmod(trashDir, 0o755);
      await rm(f.trashedRaw);
      await writeFile(f.trashedRaw, 'a-newer-file-at-the-same-path');

      await drainLocalPurges({ now: Date.now() + 3_600_000 });

      expect(await readFile(f.trashedRaw, 'utf8')).toBe('a-newer-file-at-the-same-path');
      expect(await gone(f.trashedXmp)).toBe(true);
      expect(obligations(f.live.db)).toEqual([]);
    } finally {
      await chmod(trashDir, 0o755).catch(() => {});
      await f.close();
    }
  },
);

test.each(['route', 'retention'] as const)(
  '%s purge leaves the photo in Trash while its library is offline, then completes once it is back',
  async (mode) => {
    const f = await fixture(['dupe', 'kept']);
    const offline = `${f.library}-offline`;
    try {
      await rename(f.library, offline);

      const outcome = await f.purge(mode);

      if (outcome instanceof Response) expect(outcome.status).toBe(503);
      else expect(outcome).toEqual({ scanned: 1, purged: 0, errors: 1 });
      expect(
        f.live.db
          .query(`SELECT deleted_at, apple_rendered_path FROM assets WHERE id = ?`)
          .get(f.id),
      ).toEqual({ deleted_at: OLD, apple_rendered_path: COMPANION });
      expect(
        f.live.db.query(`SELECT COUNT(*) AS n FROM asset_locations WHERE asset_id = ?`).get(f.id),
      ).toEqual({ n: 2 });
      expect(obligations(f.live.db)).toEqual([]);
      expect(f.live.db.query(`SELECT COUNT(*) AS n FROM backup_purges`).get()).toEqual({ n: 0 });

      await rename(offline, f.library);
      const again = await f.purge(mode);

      if (again instanceof Response) expect(again.status).toBe(200);
      else expect(again).toEqual({ scanned: 1, purged: 1, errors: 0 });
      expect(await gone(f.trashedRaw)).toBe(true);
      expect(await gone(f.trashedXmp)).toBe(true);
      expect(obligations(f.live.db)).toEqual([]);
      expect(await readFile(path.join(f.library, 'kept', 'IMG_1.dng'), 'utf8')).toBe(RAW);
    } finally {
      await rename(offline, f.library).catch(() => {});
      await f.close();
    }
  },
);

test.each(['route', 'retention'] as const)(
  '%s full purge keeps the row while its library is offline',
  async (mode) => {
    const f = await fixture(['solo']);
    const offline = `${f.library}-offline`;
    try {
      await rename(f.library, offline);

      const outcome = await f.purge(mode);

      if (outcome instanceof Response) expect(outcome.status).toBe(503);
      else expect(outcome).toEqual({ scanned: 1, purged: 0, errors: 1 });
      expect(f.live.db.query(`SELECT id FROM assets WHERE id = ?`).get(f.id)).toEqual({ id: f.id });
      expect(
        f.live.db.query(`SELECT COUNT(*) AS n FROM backup_lifecycle WHERE kind = 'purge'`).get(),
      ).toEqual({ n: 0 });
      await rename(offline, f.library);
      expect(await readFile(f.trashedRaw, 'utf8')).toBe(RAW);
    } finally {
      await rename(offline, f.library).catch(() => {});
      await f.close();
    }
  },
);
