/**
 * The "Canonical backup sidecars" migration (#5021): a backed-up photo's edit
 * written as `IMG.HEIC.xmp` moves to the `IMG.xmp` the server reads. When a
 * canonical sidecar already exists, the backup edit lands on top and the
 * server's version is kept as a divergence, unless a same-stem sibling shares
 * that sidecar (#4692), in which case it is kept and the backup edit recorded.
 * Real files in a temp library, driven through one migration tick.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from '../../fs/mirrored.ts';
import * as path from 'node:path';
import { stageRegistry } from '../registry.ts';
import { runMigrationTickOnce } from '../migration.ts';
import { getMigration } from './index.ts';
import { resetMigrationState, setMigrationEnabled } from '../migration-config.repo.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { createLibrary, seedAsset, type MigrationLibrary } from './migration.test-helpers.ts';

const MIGRATION_ID = 'canonical-backup-sidecars';
const DIR = '2024/Kyoto';

afterEach(() => {
  setLibraryRootsForTests(null);
  stageRegistry._resetForTests();
});

async function backupLibrary(prefix: string): Promise<MigrationLibrary> {
  const library = await createLibrary(prefix);
  setLibraryRootsForTests(new Map([[library.folderId.toHexString(), library.root]]));
  await fs.mkdir(path.join(library.root, DIR), { recursive: true });
  return library;
}

function write(library: MigrationLibrary, name: string, body: string): Promise<void> {
  return fs.writeFile(path.join(library.root, DIR, name), body);
}

function read(library: MigrationLibrary, name: string): Promise<string | null> {
  return fs.readFile(path.join(library.root, DIR, name), 'utf8').catch(() => null);
}

function backupPhoto(library: MigrationLibrary, filename: string): string {
  return seedAsset(library.db, {
    phassetDevices: ['phone'],
    location: { libraryId: library.folderId, path: DIR, filename },
  });
}

function divergences(library: MigrationLibrary) {
  return library.db
    .query(`SELECT sidecar_rel_path, displaced_xmp FROM sidecar_divergences ORDER BY rowid`)
    .all();
}

function stamped(library: MigrationLibrary, id: string): unknown {
  return (
    library.db
      .query(`SELECT backup_sidecar_name_version AS v FROM assets WHERE id = ?`)
      .get(id) as {
      v: number | null;
    }
  ).v;
}

async function runTick(): Promise<void> {
  await resetMigrationState(MIGRATION_ID);
  await setMigrationEnabled(MIGRATION_ID, true, new Date().toISOString());
  await runMigrationTickOnce(50, new Date().toISOString());
}

describe('canonical-backup-sidecars', () => {
  it('moves a backup sidecar to the canonical name when none exists', async () => {
    using library = await backupLibrary('canon-move-');
    await write(library, 'IMG_1.HEIC', 'pixels');
    await write(library, 'IMG_1.HEIC.xmp', 'backup edit');
    const id = backupPhoto(library, 'IMG_1.HEIC');

    await runTick();

    expect(await read(library, 'IMG_1.xmp')).toBe('backup edit');
    expect(await read(library, 'IMG_1.HEIC.xmp')).toBeNull();
    expect(divergences(library)).toEqual([]);
    expect(stamped(library, id)).toBe(1);
  });

  it('drops the backup copy when the canonical sidecar already holds the same edit', async () => {
    using library = await backupLibrary('canon-same-');
    await write(library, 'IMG_2.HEIC', 'pixels');
    await write(library, 'IMG_2.HEIC.xmp', 'same edit');
    await write(library, 'IMG_2.xmp', 'same edit');
    backupPhoto(library, 'IMG_2.HEIC');

    await runTick();

    expect(await read(library, 'IMG_2.xmp')).toBe('same edit');
    expect(await read(library, 'IMG_2.HEIC.xmp')).toBeNull();
    expect(divergences(library)).toEqual([]);
  });

  it('lands the backup edit on top of a server edit and keeps the server version', async () => {
    using library = await backupLibrary('canon-diverge-');
    await write(library, 'IMG_3.HEIC', 'pixels');
    await write(library, 'IMG_3.HEIC.xmp', 'backup edit');
    await write(library, 'IMG_3.xmp', 'server edit');
    backupPhoto(library, 'IMG_3.HEIC');

    await runTick();

    expect(await read(library, 'IMG_3.xmp')).toBe('backup edit');
    expect(await read(library, 'IMG_3.HEIC.xmp')).toBeNull();
    expect(divergences(library)).toEqual([
      { sidecar_rel_path: `${DIR}/IMG_3.xmp`, displaced_xmp: 'server edit' },
    ]);
  });

  it('keeps a sidecar shared with a same-stem sibling and records the backup edit', async () => {
    using library = await backupLibrary('canon-shared-');
    await write(library, 'IMG_4.jpg', 'pixels');
    await write(library, 'IMG_4.cr2', 'raw pixels');
    await write(library, 'IMG_4.xmp', 'jpeg edit');
    await write(library, 'IMG_4.cr2.xmp', 'raw backup edit');
    backupPhoto(library, 'IMG_4.jpg');
    backupPhoto(library, 'IMG_4.cr2');

    await runTick();

    expect(await read(library, 'IMG_4.xmp')).toBe('jpeg edit');
    expect(await read(library, 'IMG_4.cr2.xmp')).toBeNull();
    expect(divergences(library)).toEqual([
      { sidecar_rel_path: `${DIR}/IMG_4.xmp`, displaced_xmp: 'raw backup edit' },
    ]);
  });

  it("leaves a video's full-name sidecar alone, since that is its canonical name", async () => {
    using library = await backupLibrary('canon-video-');
    await write(library, 'IMG_5.MOV', 'frames');
    await write(library, 'IMG_5.MOV.xmp', 'clip edit');
    const id = seedAsset(library.db, {
      mediaKind: 'video',
      phassetDevices: ['phone'],
      location: { libraryId: library.folderId, path: DIR, filename: 'IMG_5.MOV' },
    });

    await runTick();

    expect(await read(library, 'IMG_5.MOV.xmp')).toBe('clip edit');
    expect(stamped(library, id)).toBe(1);
  });

  it('leaves a photo whose library is offline for a later tick', async () => {
    using library = await backupLibrary('canon-offline-');
    await write(library, 'IMG_6.HEIC', 'pixels');
    await write(library, 'IMG_6.HEIC.xmp', 'backup edit');
    const id = backupPhoto(library, 'IMG_6.HEIC');
    setLibraryRootsForTests(new Map());

    await runTick();

    expect(await read(library, 'IMG_6.HEIC.xmp')).toBe('backup edit');
    expect(stamped(library, id)).toBeNull();
  });

  it('counts down to nothing remaining once every backup photo is handled', async () => {
    using library = await backupLibrary('canon-count-');
    await write(library, 'IMG_7.HEIC', 'pixels');
    await write(library, 'IMG_7.HEIC.xmp', 'backup edit');
    backupPhoto(library, 'IMG_7.HEIC');
    const migration = getMigration(MIGRATION_ID)!;
    expect(await migration.countRemaining()).toBe(1);

    await runTick();

    expect(await migration.countRemaining()).toBe(0);
  });
});
