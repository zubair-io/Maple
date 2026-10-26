/**
 * A photo with two copies, `dupe` trashed and `kept` outside Trash, backed up
 * to a folder mirror or to Google Drive behind the fake Drive transport. Real
 * library files, the real trash action and one real SQLite database (#5419).
 */

import { expect } from 'bun:test';
import { Elysia } from 'elysia';
import * as path from 'node:path';
import { copyFile, mkdir, writeFile } from '../fs/mirrored.ts';
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
import { BackupEngine } from '../cloud-backup/engine.ts';
import { GoogleDriveProvider } from '../cloud-backup/google/provider.ts';
import { googleStore } from '../cloud-backup/google/google-store.test-helpers.ts';
import type { GoogleFetch } from '../cloud-backup/google/oauth.ts';
import { prepareTrashPurge, releaseTrashPurge } from '../cloud-backup/lifecycle.ts';
import { capturedTrashPurge } from '../cloud-backup/trash-purge-admission.ts';
import { findCoreInfoById } from '../db/repos/assets.repo.ts';
import { trashRoutes } from '../routes/assets/trash.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { trashAssetById } from './asset-trash.ts';

export const RAW = 'kept-raw-bytes';
export const COMPANION = 'kept/IMG_E1.jpg';
export const OLD = '2000-01-01T00:00:00.000Z';

type Kind = 'folder' | 'google-drive';
type Fixture = Awaited<ReturnType<typeof recoveryFixture>>;
const COPIES = ['dupe', 'kept'] as const;

async function writeLibrary(library: string) {
  for (const dir of COPIES) {
    await mkdir(path.join(library, dir), { recursive: true });
    await writeFile(path.join(library, dir, 'IMG_1.dng'), RAW);
    await writeFile(path.join(library, dir, 'IMG_1.xmp'), `<x:xmpmeta>${dir} edit</x:xmpmeta>`);
  }
  await writeFile(path.join(library, COMPANION), 'rendered-edit');
}

function insertPhoto(f: Fixture, libraryId: string): string {
  const id = insertAsset(f.live.db);
  run(
    f.live.db,
    `UPDATE assets SET size = ?, rating = 4, apple_rendered_path = ? WHERE id = ?`,
    RAW.length,
    COMPANION,
    id,
  );
  for (const [ordinal, dir] of COPIES.entries())
    insertLocation(f.live.db, {
      assetId: id,
      libraryId,
      ordinal,
      path: dir,
      filename: 'IMG_1.dng',
    });
  return id;
}

/** The fake Drive behind a real Google Drive provider; removals can be made to fail. */
function fakeDrive() {
  const store = googleStore();
  const state = { failRemovals: false };
  const transport: GoogleFetch = async (url, init) => {
    if (state.failRemovals && init?.method === 'DELETE') throw new Error('Drive is unreachable');
    return store.transport(url, init);
  };
  const engine = new BackupEngine(
    async (destination) =>
      new GoogleDriveProvider(destination.rootId!, async () => 'token', transport),
    backupEngine.repo,
  );
  return { store, state, engine };
}

async function createDestination(f: Fixture, kind: Kind, libraryId: string, mirror: string) {
  const created = await backupEngine.repo.createDestination({
    libraryId,
    kind,
    name: kind,
    path: kind === 'folder' ? mirror : null,
  });
  if (kind === 'google-drive') {
    await backupEngine.repo.updateDestination(created.id, { enabled: true });
    run(
      f.live.db,
      `UPDATE backup_destinations SET root_id = 'maple-root' WHERE id = ?`,
      created.id,
    );
  }
  return (await backupEngine.repo.destination(created.id))!;
}

function mirrorCopier(library: string, mirror: string) {
  const mirrorOf = (target: string) => path.join(mirror, path.relative(library, target));
  const backUp = async (target: string) => {
    await mkdir(path.dirname(mirrorOf(target)), { recursive: true });
    await copyFile(target, mirrorOf(target));
  };
  return { mirrorOf, backUp };
}

async function mirrorBothCopies(
  library: string,
  destinationId: string,
  id: string,
  backUp: (target: string) => Promise<void>,
) {
  for (const [ordinal, dir] of COPIES.entries())
    await backupEngine.repo.ensureEntry(destinationId, id, ordinal, `${dir}/IMG_1.dng`);
  for (const dir of COPIES)
    for (const name of ['IMG_1.dng', 'IMG_1.xmp']) await backUp(path.join(library, dir, name));
  await backUp(path.join(library, COMPANION));
}

export async function twoCopyPhoto(kind: Kind) {
  const f = await recoveryFixture();
  const library = path.join(f.root, 'library');
  const mirror = path.join(f.root, 'mirror');
  const { mirrorOf, backUp } = mirrorCopier(library, mirror);
  await writeLibrary(library);
  const libraryId = insertFolder(f.live.db, { path: library });
  invalidateLibraryRoots();
  const id = insertPhoto(f, libraryId);
  const { store, state, engine } = fakeDrive();
  const destination = await createDestination(f, kind, libraryId, mirror);
  if (kind === 'google-drive') expect(await engine.backupAsset(id)).toBe(true);
  else await mirrorBothCopies(library, destination.id, id, backUp);

  const trashed = await trashAssetById(new ObjectId(id), {
    entry: { libraryId: new ObjectId(libraryId), path: 'dupe', filename: 'IMG_1.dng' },
  });
  expect(trashed.kind).toBe('ok');
  run(f.live.db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, OLD, id);
  const trashedRaw = path.join(library, '.maple', 'trash', 'dupe', 'IMG_1.dng');
  if (kind === 'folder')
    for (const name of ['IMG_1.dng', 'IMG_1.xmp'])
      await backUp(path.join(library, '.maple', 'trash', 'dupe', name));

  const app = new Elysia().use(fakeAuth()).group('/api/assets', (g) => g.use(trashRoutes));
  const keptEntryIds = async () =>
    (await backupEngine.repo.entries(destination.id, id))
      .filter((entry) => entry.source_path === 'kept/IMG_1.dng')
      .map((entry) => entry.id);
  return {
    ...f,
    library,
    mirror,
    mirrorOf,
    id,
    destination,
    engine,
    store,
    trashedRaw,
    keptRaw: path.join(library, 'kept', 'IMG_1.dng'),
    keptEntryIds,
    failDriveRemovals(fail: boolean) {
      state.failRemovals = fail;
    },
    setKeptMissing(missing: boolean) {
      run(
        f.live.db,
        `UPDATE asset_locations SET missing_since = ? WHERE asset_id = ? AND path = 'kept'`,
        missing ? OLD : null,
        id,
      );
    },
    /** What an earlier attempt that found no surviving copy recorded; `stopped`
     * releases it as that attempt does when it fails short of the row delete. */
    async recordWholePhotoPurge({ stopped = true } = {}) {
      const info = (await findCoreInfoById(new ObjectId(id)))!;
      expect(await prepareTrashPurge(id, capturedTrashPurge(info))).toBe(true);
      if (stopped) await releaseTrashPurge(id);
    },
    purgeRoute() {
      return app.handle(
        new Request(`http://localhost/api/assets/${id}?intent=purge`, { method: 'DELETE' }),
      );
    },
    /** Remote objects saved for an entry, by key. */
    remoteObjects(entryId: string) {
      return f.live.db
        .query(
          `SELECT key FROM backup_objects WHERE destination_id = ? AND entry_id = ? AND object IS NOT NULL`,
        )
        .all(destination.id, entryId) as Array<{ key: string }>;
    },
    /** Whether Drive still holds an object under `key`. */
    async driveHas(key: string) {
      const provider = new GoogleDriveProvider('maple-root', async () => 'token', store.transport);
      return (await provider.inspect(key)) !== null;
    },
  };
}
