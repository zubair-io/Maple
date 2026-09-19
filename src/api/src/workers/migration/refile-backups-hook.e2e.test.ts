/**
 * The describe stage's on-the-fly screenshot relocation.
 *
 * When the vision model flips a backup photo to "screenshot" that the ingest
 * filename heuristic missed, the asset is filed under `<year>/Screenshot`
 * immediately rather than waiting for an operator to run the cleanup. Two
 * refusals keep that narrow: the `<year>/Screenshot` layout is the PhotoKit
 * backup contract, so a folder-scanned library is left exactly as the user
 * arranged it, and an asset already filed there is not moved again.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toObjectId } from '../../db/sqlite/repos/values.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { relocateBackupScreenshot } from './refile-backups.ts';
import {
  createLibrary,
  locationsOf,
  seedAsset,
  type MigrationLibrary,
} from './migration.test-helpers.ts';

afterEach(() => setLibraryRootsForTests(null));

/** A library whose root the relocation can resolve. */
async function createBackupLibrary(prefix: string): Promise<MigrationLibrary> {
  const library = await createLibrary(prefix);
  setLibraryRootsForTests(new Map([[library.folderId.toHexString(), library.root]]));
  return library;
}

async function writeFile(library: MigrationLibrary, rel: string, name: string): Promise<void> {
  await fs.mkdir(path.join(library.root, ...rel.split('/')), { recursive: true });
  await fs.writeFile(path.join(library.root, rel, name), 'pixels');
}

describe('relocateBackupScreenshot (describe-stage hook)', () => {
  it('files a backup screenshot the ingest heuristic missed into year/Screenshot', async () => {
    using library = await createBackupLibrary('refile-reloc-');
    const oldRel = '2024/03';
    await writeFile(library, oldRel, 'IMG_4523.PNG');

    const id = seedAsset(library.db, {
      mapleId: 'refile-reloc-id',
      phassetDevices: ['dev'],
      // Still false in the database — the relocation trusts the caller's
      // verdict, because the describe handler calls it before its own patch is
      // persisted.
      isScreenshot: false,
      stages: ['thumb', 'preview'],
      location: { libraryId: library.folderId, path: oldRel, filename: 'IMG_4523.PNG' },
    });

    expect(await relocateBackupScreenshot(toObjectId(id))).toBe('moved');
    expect(locationsOf(library.db, id)[0]!.path).toBe('2024/Screenshot');
    expect(await fs.readFile(path.join(library.root, '2024/Screenshot/IMG_4523.PNG'), 'utf8')).toBe(
      'pixels',
    );
  });

  it('is not-applicable for an asset that did not come from a backup', async () => {
    using library = await createBackupLibrary('refile-reloc-nb-');
    const rel = '2024/03';
    await writeFile(library, rel, 'IMG_X.PNG');

    const id = seedAsset(library.db, {
      mapleId: 'refile-reloc-nb-id',
      location: { libraryId: library.folderId, path: rel, filename: 'IMG_X.PNG' },
    });

    expect(await relocateBackupScreenshot(toObjectId(id))).toBe('not-applicable');
    expect(locationsOf(library.db, id)[0]!.path).toBe(rel);
  });

  it('is not-applicable when already filed under year/Screenshot', async () => {
    using library = await createBackupLibrary('refile-reloc-af-');

    const id = seedAsset(library.db, {
      mapleId: 'refile-reloc-af-id',
      phassetDevices: ['dev'],
      location: { libraryId: library.folderId, path: '2024/Screenshot', filename: 'IMG_Y.PNG' },
    });

    expect(await relocateBackupScreenshot(toObjectId(id))).toBe('not-applicable');
  });
});
