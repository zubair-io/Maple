/**
 * End-to-end coverage for the legacy day-dir cleanup.
 *
 * These assets are the ones `refile-backups` cannot fix: it requires a PhotoKit
 * link some of them never had, and its year rule deliberately keeps whatever
 * year the existing path claims, so an asset filed under the *wrong* year is
 * only ever flattened. This migration takes the year from EXIF, or — when there
 * is none — from an Android default-camera filename, and files it afresh.
 *
 * The two refusals matter as much as the moves. An asset with neither source is
 * stamped and left exactly where it is, for manual review rather than a guess.
 * And a library root that is not on disk at all is an offline mount, not
 * evidence that every file under it is gone, so nothing is stamped and a later
 * tick re-verifies.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { stageRegistry } from '../registry.ts';
import { runMigrationTickOnce } from '../migration.ts';
import { LEGACY_DAYDIR_VERSION, refileLegacyDaydir } from './refile-legacy-daydir.ts';
import { resetMigrationState, setMigrationEnabled } from '../migration-config.repo.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import {
  assetRow,
  createLibrary,
  locationsOf,
  seedAsset,
  seedLocation,
  type MigrationLibrary,
} from './migration.test-helpers.ts';

const MIGRATION_ID = 'refile-legacy-daydir';

/** An Android default-camera filename, whose date the fallback parses. */
const ANDROID = 'IMG_20170930_121056_345.jpg';

const NO_EXIF = { captured_at: null, captured_year: null, captured_month: null };

afterEach(() => {
  setLibraryRootsForTests(null);
  stageRegistry._resetForTests();
});

async function createDaydirLibrary(prefix: string): Promise<MigrationLibrary> {
  const library = await createLibrary(prefix);
  setLibraryRootsForTests(new Map([[library.folderId.toHexString(), library.root]]));
  return library;
}

async function writeFile(library: MigrationLibrary, rel: string, name: string): Promise<void> {
  await fs.mkdir(path.join(library.root, ...rel.split('/')), { recursive: true });
  await fs.writeFile(path.join(library.root, rel, name), 'pixels');
}

async function runTick(): Promise<void> {
  await resetMigrationState(MIGRATION_ID);
  await setMigrationEnabled(MIGRATION_ID, true, new Date().toISOString());
  await runMigrationTickOnce(50, new Date().toISOString());
}

describe('refile-legacy-daydir end-to-end', () => {
  it('moves a day-dir asset using the filename date when there is no EXIF', async () => {
    using library = await createDaydirLibrary('refile-legacy-daydir-');
    const oldRel = '2021/61st Street/01-05';
    await writeFile(library, oldRel, ANDROID);

    const id = seedAsset(library.db, {
      mapleId: 'legacy-daydir-filename-fallback',
      isScreenshot: false,
      exif: NO_EXIF,
      location: { libraryId: library.folderId, path: oldRel, filename: ANDROID },
    });

    await runTick();

    const live = locationsOf(library.db, id)[0]!;
    // The path claimed 2021; the filename says 2017, and the filename wins.
    expect(live.path).toBe('2017/Misc');
    expect(live.filename).toBe(ANDROID);
    expect(assetRow(library.db, id)!.legacy_daydir_version).toBe(LEGACY_DAYDIR_VERSION);

    expect(await fs.readFile(path.join(library.root, '2017', 'Misc', ANDROID), 'utf8')).toBe(
      'pixels',
    );
    await expect(fs.stat(path.join(library.root, oldRel))).rejects.toThrow();

    // A second tick finds nothing left to do — the stamp excludes it.
    expect(await refileLegacyDaydir.countRemaining()).toBe(0);
  });

  it('stamps an unresolvable asset and leaves it exactly where it is', async () => {
    using library = await createDaydirLibrary('refile-legacy-daydir-');
    const oldRel = '2021/Some Place/03-11';
    await writeFile(library, oldRel, 'DSC_0001.jpg');

    const id = seedAsset(library.db, {
      mapleId: 'legacy-daydir-unresolved',
      isScreenshot: false,
      exif: NO_EXIF,
      location: { libraryId: library.folderId, path: oldRel, filename: 'DSC_0001.jpg' },
    });

    await runTick();

    expect(locationsOf(library.db, id)[0]!.path).toBe(oldRel);
    expect(assetRow(library.db, id)!.legacy_daydir_version).toBe(LEGACY_DAYDIR_VERSION);
    expect(await fs.readFile(path.join(library.root, oldRel, 'DSC_0001.jpg'), 'utf8')).toBe(
      'pixels',
    );
  });

  it('moves the no-location day-dir shape (<year>/<MM>/<DD>) into <year>/Misc', async () => {
    using library = await createDaydirLibrary('refile-legacy-daydir-nolocation-');
    const oldRel = '2021/01/05';
    await writeFile(library, oldRel, ANDROID);

    const id = seedAsset(library.db, {
      mapleId: 'legacy-daydir-no-location',
      isScreenshot: false,
      exif: NO_EXIF,
      location: { libraryId: library.folderId, path: oldRel, filename: ANDROID },
    });

    await runTick();

    expect(locationsOf(library.db, id)[0]!.path).toBe('2017/Misc');
    expect(assetRow(library.db, id)!.legacy_daydir_version).toBe(LEGACY_DAYDIR_VERSION);
    expect(await fs.readFile(path.join(library.root, '2017', 'Misc', ANDROID), 'utf8')).toBe(
      'pixels',
    );
    await expect(fs.stat(path.join(library.root, oldRel))).rejects.toThrow();
  });

  it('resolves via EXIF when present, overriding a disagreeing filename date', async () => {
    using library = await createDaydirLibrary('refile-legacy-daydir-exif-');
    const oldRel = '2021/61st Street/01-05';
    await writeFile(library, oldRel, ANDROID);

    const id = seedAsset(library.db, {
      mapleId: 'legacy-daydir-exif-priority',
      isScreenshot: false,
      exif: { captured_at: '2021-01-05T00:00:00.000Z', captured_year: 2021, captured_month: 1 },
      location: { libraryId: library.folderId, path: oldRel, filename: ANDROID },
    });

    await runTick();

    expect(locationsOf(library.db, id)[0]!.path).toBe('2021/Misc');
    expect(assetRow(library.db, id)!.legacy_daydir_version).toBe(LEGACY_DAYDIR_VERSION);
  });

  it('does not stamp when the library root itself is unavailable (offline mount)', async () => {
    // A root that is not on disk at all: every child path ENOENTs
    // indistinguishably from a genuinely deleted file, so a stamp here would
    // permanently give up on a file that is merely unreachable.
    using library = await createLibrary('refile-legacy-daydir-offline-');
    const offlineRoot = path.join(tmpdir(), `refile-daydir-offline-${Date.now()}`);
    setLibraryRootsForTests(new Map([[library.folderId.toHexString(), offlineRoot]]));

    const oldRel = '2021/61st Street/01-05';
    const id = seedAsset(library.db, {
      mapleId: 'legacy-daydir-offline-root',
      isScreenshot: false,
      exif: NO_EXIF,
      location: { libraryId: library.folderId, path: oldRel, filename: ANDROID },
    });

    await runTick();

    expect(locationsOf(library.db, id)[0]!.path).toBe(oldRel);
    expect(assetRow(library.db, id)!.legacy_daydir_version).toBeNull();
  });

  it('moves the validated live entry, not a stale missing-tagged earlier one', async () => {
    // Only the second location has a file on disk. The first is tagged missing
    // rather than deleted, so the move's own "first non-deleted" pick — which
    // ignores the missing tag — would select it if the asset were handed over
    // unnarrowed.
    using library = await createDaydirLibrary('refile-legacy-daydir-multientry-');
    const liveRel = '2021/61st Street/01-05';
    await writeFile(library, liveRel, ANDROID);

    const id = seedAsset(library.db, {
      mapleId: 'legacy-daydir-multientry',
      isScreenshot: false,
      exif: NO_EXIF,
    });
    seedLocation(library.db, {
      assetId: id,
      libraryId: library.folderId,
      ordinal: 0,
      path: '2021/StaleEntry',
      filename: 'GHOST.HEIC',
      missingSince: '2020-01-01T00:00:00.000Z',
    });
    seedLocation(library.db, {
      assetId: id,
      libraryId: library.folderId,
      ordinal: 1,
      path: liveRel,
      filename: ANDROID,
    });

    await runTick();

    const live = locationsOf(library.db, id).find((row) => row.filename === ANDROID);
    expect(live?.path).toBe('2017/Misc');
    expect(assetRow(library.db, id)!.legacy_daydir_version).toBe(LEGACY_DAYDIR_VERSION);
    expect(await fs.readFile(path.join(library.root, '2017', 'Misc', ANDROID), 'utf8')).toBe(
      'pixels',
    );
  });
});
