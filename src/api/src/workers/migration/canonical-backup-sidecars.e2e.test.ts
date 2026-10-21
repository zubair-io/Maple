/**
 * The "Canonical backup sidecars" migration (#5021): a backed-up photo's edit
 * written as `IMG.HEIC.xmp` moves to the `IMG.xmp` the server reads. When a
 * canonical sidecar already exists, the backup edit lands on top and the
 * server's version is kept as a divergence, unless a same-stem sibling shares
 * that sidecar (#4692), in which case it is kept and the backup edit recorded.
 * Real files in a temp library, driven through one migration tick.
 */
import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import * as rootHelpers from '../missing-reaper.helpers.ts';
import * as xmpChange from '../../routes/xmp-change.ts';
import * as fs from '../../fs/mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { stageRegistry } from '../registry.ts';
import { runMigrationTickOnce } from '../migration.ts';
import { getMigration } from './index.ts';
import { canonicalBackupSidecars } from './canonical-backup-sidecars.ts';
import {
  loadMigrationState,
  resetMigrationState,
  setMigrationEnabled,
} from '../migration-config.repo.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { createLibrary, seedAsset, type MigrationLibrary } from './migration.test-helpers.ts';
import { serializeSidecarWrite } from '../../fs/sidecar-write-order.ts';

const MIGRATION_ID = 'canonical-backup-sidecars';
const caseSensitiveTmp = await (async () => {
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-case-probe-'));
  try {
    await fs.writeFile(path.join(probe, 'a'), '');
    return !(await fs.lstat(path.join(probe, 'A')).then(
      () => true,
      () => false,
    ));
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
})();
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const maple = (label: string) =>
  `<x:xmpmeta xmlns:papp="http://ns.justmaple.app/photo/1.0/">${label}</x:xmpmeta>`;
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

function stamped(library: MigrationLibrary, id: string): boolean {
  return (
    library.db
      .query(`SELECT 1 FROM backup_sidecar_name_checks WHERE asset_id = ? AND checked = 1`)
      .get(id) !== null
  );
}

/** One batch of the migration's work. */
async function runTick(): Promise<void> {
  await canonicalBackupSidecars.runBatch(50);
}

describe('canonical-backup-sidecars', () => {
  it('runs once an operator enables it on Settings', async () => {
    using library = await backupLibrary('canon-enabled-');
    await write(library, 'IMG_0.HEIC', 'pixels');
    await write(library, 'IMG_0.HEIC.xmp', maple('backup edit'));
    backupPhoto(library, 'IMG_0.HEIC');
    await resetMigrationState(MIGRATION_ID);
    await setMigrationEnabled(MIGRATION_ID, true, new Date().toISOString());

    await runMigrationTickOnce(50, new Date().toISOString());

    expect(await read(library, 'IMG_0.xmp')).toBe(maple('backup edit'));
    expect(await read(library, 'IMG_0.HEIC.xmp')).toBeNull();
    expect((await loadMigrationState(MIGRATION_ID)).last_error).toBeNull();
  });

  it('moves a backup sidecar to the canonical name when none exists', async () => {
    using library = await backupLibrary('canon-move-');
    await write(library, 'IMG_1.HEIC', 'pixels');
    await write(library, 'IMG_1.HEIC.xmp', maple('backup edit'));
    const id = backupPhoto(library, 'IMG_1.HEIC');

    await runTick();

    expect(await read(library, 'IMG_1.xmp')).toBe(maple('backup edit'));
    expect(await read(library, 'IMG_1.HEIC.xmp')).toBeNull();
    expect(divergences(library)).toEqual([]);
    expect(stamped(library, id)).toBe(true);
  });

  it('drops the backup copy when the canonical sidecar already holds the same edit', async () => {
    using library = await backupLibrary('canon-same-');
    await write(library, 'IMG_2.HEIC', 'pixels');
    await write(library, 'IMG_2.HEIC.xmp', maple('same edit'));
    await write(library, 'IMG_2.xmp', maple('same edit'));
    backupPhoto(library, 'IMG_2.HEIC');

    await runTick();

    expect(await read(library, 'IMG_2.xmp')).toBe(maple('same edit'));
    expect(await read(library, 'IMG_2.HEIC.xmp')).toBeNull();
    expect(divergences(library)).toEqual([]);
  });

  // The worker can't overwrite across processes safely; a live device's re-send
  // still puts its edit on top through the API process.
  it('keeps an existing server edit active and records the backup edit aside', async () => {
    using library = await backupLibrary('canon-diverge-');
    await write(library, 'IMG_3.HEIC', 'pixels');
    await write(library, 'IMG_3.HEIC.xmp', maple('backup edit'));
    await write(library, 'IMG_3.xmp', maple('server edit'));
    backupPhoto(library, 'IMG_3.HEIC');

    await runTick();

    expect(await read(library, 'IMG_3.xmp')).toBe(maple('server edit'));
    expect(await read(library, 'IMG_3.HEIC.xmp')).toBeNull();
    expect(divergences(library)).toEqual([
      { sidecar_rel_path: `${DIR}/IMG_3.xmp`, displaced_xmp: maple('backup edit') },
    ]);
  });

  it('keeps a sidecar shared with a same-stem sibling and records the backup edit', async () => {
    using library = await backupLibrary('canon-shared-');
    await write(library, 'IMG_4.jpg', 'pixels');
    await write(library, 'IMG_4.cr2', 'raw pixels');
    await write(library, 'IMG_4.xmp', maple('jpeg edit'));
    await write(library, 'IMG_4.cr2.xmp', maple('raw backup edit'));
    backupPhoto(library, 'IMG_4.jpg');
    backupPhoto(library, 'IMG_4.cr2');

    await runTick();

    expect(await read(library, 'IMG_4.xmp')).toBe(maple('jpeg edit'));
    expect(await read(library, 'IMG_4.cr2.xmp')).toBeNull();
    expect(divergences(library)).toEqual([
      { sidecar_rel_path: `${DIR}/IMG_4.xmp`, displaced_xmp: maple('raw backup edit') },
    ]);
  });

  it("leaves a video's full-name sidecar alone, since that is its canonical name", async () => {
    using library = await backupLibrary('canon-video-');
    await write(library, 'IMG_5.MOV', 'frames');
    await write(library, 'IMG_5.MOV.xmp', maple('clip edit'));
    const id = seedAsset(library.db, {
      mediaKind: 'video',
      phassetDevices: ['phone'],
      location: { libraryId: library.folderId, path: DIR, filename: 'IMG_5.MOV' },
    });

    await runTick();

    expect(await read(library, 'IMG_5.MOV.xmp')).toBe(maple('clip edit'));
    expect(stamped(library, id)).toBe(true);
  });

  it('leaves a photo whose library is offline for a later tick', async () => {
    using library = await backupLibrary('canon-offline-');
    await write(library, 'IMG_6.HEIC', 'pixels');
    await write(library, 'IMG_6.HEIC.xmp', maple('backup edit'));
    const id = backupPhoto(library, 'IMG_6.HEIC');
    setLibraryRootsForTests(new Map());

    await runTick();

    expect(await read(library, 'IMG_6.HEIC.xmp')).toBe(maple('backup edit'));
    expect(stamped(library, id)).toBe(false);
  });

  it('leaves a photo whose mount is gone for a later tick', async () => {
    using library = await backupLibrary('canon-unmounted-');
    await write(library, 'IMG_8.HEIC', 'pixels');
    await write(library, 'IMG_8.HEIC.xmp', maple('backup edit'));
    const id = backupPhoto(library, 'IMG_8.HEIC');
    setLibraryRootsForTests(
      new Map([[library.folderId.toHexString(), path.join(library.root, 'unmounted')]]),
    );

    await runTick();

    expect(stamped(library, id)).toBe(false);
  });

  it('leaves an old-name sidecar another tool wrote untouched', async () => {
    using library = await backupLibrary('canon-foreign-');
    const foreign = '<x:xmpmeta xmlns:darktable="http://darktable.sf.net/">dt</x:xmpmeta>';
    await write(library, 'IMG_9.JPG', 'pixels');
    await write(library, 'IMG_9.JPG.xmp', foreign);
    const id = backupPhoto(library, 'IMG_9.JPG');

    await runTick();

    expect(await read(library, 'IMG_9.JPG.xmp')).toBe(foreign);
    expect(await read(library, 'IMG_9.xmp')).toBeNull();
    expect(stamped(library, id)).toBe(true);
  });

  it('stamps a photo whose old-name sidecar is a link and leaves the link', async () => {
    using library = await backupLibrary('canon-link-');
    await write(library, 'IMG_10.HEIC', 'pixels');
    await fs.symlink(
      path.join(library.root, DIR, 'IMG_10.HEIC'),
      path.join(library.root, DIR, 'IMG_10.HEIC.xmp'),
    );
    const id = backupPhoto(library, 'IMG_10.HEIC');

    await runTick();

    expect(await read(library, 'IMG_10.xmp')).toBeNull();
    expect(stamped(library, id)).toBe(true);
  });

  it('marks a moved edit as a server edit of the photo', async () => {
    using library = await backupLibrary('canon-bookkeeping-');
    await write(library, 'IMG_11.HEIC', 'pixels');
    await write(library, 'IMG_11.HEIC.xmp', maple('backup edit'));
    const id = backupPhoto(library, 'IMG_11.HEIC');

    await runTick();

    expect(
      library.db.query(`SELECT has_xmp, sidecar_ver FROM assets WHERE id = ?`).get(id),
    ).toEqual({ has_xmp: 1, sidecar_ver: 2 });
  });

  it('moves an edit written under an older Maple namespace', async () => {
    using library = await backupLibrary('canon-old-ns-');
    const older = '<x:xmpmeta xmlns:maple="https://maple.app/ns/1.0/">older</x:xmpmeta>';
    await write(library, 'IMG_12.HEIC', 'pixels');
    await write(library, 'IMG_12.HEIC.xmp', older);
    backupPhoto(library, 'IMG_12.HEIC');

    await runTick();

    expect(await read(library, 'IMG_12.xmp')).toBe(older);
  });

  it('checks a merge survivor that no longer carries a PhotoKit link', async () => {
    using library = await backupLibrary('canon-merged-');
    await write(library, 'IMG_13.HEIC', 'pixels');
    await write(library, 'IMG_13.HEIC.xmp', maple('backup edit'));
    const id = seedAsset(library.db, {
      location: { libraryId: library.folderId, path: DIR, filename: 'IMG_13.HEIC' },
    });
    library.db
      .query('INSERT INTO backup_sidecar_name_checks (asset_id, checked) VALUES (?, 0)')
      .run(id);

    await runTick();

    expect(await read(library, 'IMG_13.xmp')).toBe(maple('backup edit'));
    expect(stamped(library, id)).toBe(true);
  });

  it('removes an old-name file a device send already superseded, without replaying it', async () => {
    using library = await backupLibrary('canon-superseded-');
    await write(library, 'IMG_14.HEIC', 'pixels');
    await write(library, 'IMG_14.HEIC.xmp', maple('older send'));
    await write(library, 'IMG_14.xmp', maple('newer edit'));
    const id = backupPhoto(library, 'IMG_14.HEIC');
    library.db
      .query(
        `INSERT INTO sidecar_divergences
           (id, asset_id, library_id, sidecar_rel_path, device_id, base_sha256,
            displaced_sha256, displaced_xmp, incoming_sha256, created_at)
         VALUES ('aaaaaaaaaaaaaaaaaaaaaaaa', ?, ?, ?, 'phone', NULL, ?, ?, ?, '2024-01-01')`,
      )
      .run(
        id,
        library.folderId.toHexString(),
        `${DIR}/IMG_14.xmp`,
        sha256(maple('older send')),
        maple('older send'),
        sha256(maple('newer edit')),
      );

    await runTick();

    expect(await read(library, 'IMG_14.xmp')).toBe(maple('newer edit'));
    expect(await read(library, 'IMG_14.HEIC.xmp')).toBeNull();
  });

  it('leaves an old-name file alone when its photo moves while the migration waits', async () => {
    using library = await backupLibrary('canon-moved-');
    await write(library, 'IMG_15.HEIC', 'pixels');
    await write(library, 'IMG_15.HEIC.xmp', maple('backup edit'));
    const id = backupPhoto(library, 'IMG_15.HEIC');
    const canonical = path.join(library.root, DIR, 'IMG_15.xmp');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const holder = serializeSidecarWrite(canonical, async () => {
      entered();
      await held;
    });
    await inside;

    const tick = runTick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    library.db.query(`UPDATE asset_locations SET path = '2024/Moved' WHERE asset_id = ?`).run(id);
    release();
    await holder;
    await tick;

    expect(await read(library, 'IMG_15.xmp')).toBeNull();
    expect(await read(library, 'IMG_15.HEIC.xmp')).toBe(maple('backup edit'));
    expect(stamped(library, id)).toBe(false);
  });

  it("leaves another photo's sidecar alone when its name looks like an old-name file", async () => {
    using library = await backupLibrary('canon-lookalike-');
    await write(library, 'IMG_16.HEIC', 'pixels');
    await write(library, 'IMG_16.HEIC.JPG', 'converted');
    await write(library, 'IMG_16.HEIC.xmp', maple('edit of the JPG'));
    backupPhoto(library, 'IMG_16.HEIC');

    await runTick();

    expect(await read(library, 'IMG_16.HEIC.xmp')).toBe(maple('edit of the JPG'));
    expect(await read(library, 'IMG_16.xmp')).toBeNull();
  });

  it('does not stamp a photo whose volume went away during the scan', async () => {
    using library = await backupLibrary('canon-unmounted-mid-');
    const emptyMountPoint = path.join(library.root, 'unmounted');
    await fs.mkdir(emptyMountPoint);
    const id = backupPhoto(library, 'IMG_17.HEIC');
    setLibraryRootsForTests(new Map([[library.folderId.toHexString(), emptyMountPoint]]));
    const mounted = spyOn(rootHelpers, 'libraryRootAvailable')
      .mockImplementationOnce(async () => true)
      .mockImplementation(async () => false);
    try {
      await runTick();
    } finally {
      mounted.mockRestore();
    }

    expect(stamped(library, id)).toBe(false);
  });

  it('keeps the old-name file when its photo moves between the create and the removal', async () => {
    using library = await backupLibrary('canon-moved-after-create-');
    await write(library, 'IMG_18.HEIC', 'pixels');
    await write(library, 'IMG_18.HEIC.xmp', maple('backup edit'));
    const id = backupPhoto(library, 'IMG_18.HEIC');
    const landed = spyOn(xmpChange, 'announceSidecarLanded').mockImplementation(async () => {
      library.db.query(`UPDATE asset_locations SET path = '2024/Moved' WHERE asset_id = ?`).run(id);
    });
    try {
      await runTick();
    } finally {
      landed.mockRestore();
    }

    expect(await read(library, 'IMG_18.HEIC.xmp')).toBe(maple('backup edit'));
  });

  it('moves an old-name edit stored in a different case', async () => {
    using library = await backupLibrary('canon-case-');
    await write(library, 'IMG_11.HEIC', 'pixels');
    await write(library, 'img_11.heic.xmp', maple('backup edit'));
    const id = backupPhoto(library, 'IMG_11.HEIC');

    await runTick();

    expect(await read(library, 'IMG_11.xmp')).toBe(maple('backup edit'));
    expect(await read(library, 'img_11.heic.xmp')).toBeNull();
    expect(stamped(library, id)).toBe(true);
  });

  it.skipIf(!caseSensitiveTmp)(
    'handles every spelling of an old-name edit before stamping the photo',
    async () => {
      using library = await backupLibrary('canon-two-spellings-');
      await write(library, 'IMG_12.HEIC', 'pixels');
      await write(library, 'IMG_12.HEIC.xmp', maple('exact spelling'));
      await write(library, 'img_12.heic.xmp', maple('other spelling'));
      const id = backupPhoto(library, 'IMG_12.HEIC');

      await runTick();

      expect(await read(library, 'IMG_12.xmp')).toBe(maple('exact spelling'));
      expect(await read(library, 'IMG_12.HEIC.xmp')).toBeNull();
      expect(await read(library, 'img_12.heic.xmp')).toBeNull();
      expect(divergences(library)).toEqual([
        { sidecar_rel_path: `${DIR}/IMG_12.xmp`, displaced_xmp: maple('other spelling') },
      ]);
      expect(stamped(library, id)).toBe(true);
    },
  );

  // Root lists a directory without read permission anyway.
  it.skipIf(process.getuid?.() === 0)(
    "doesn't stamp a photo whose folder can't be listed to rule out another owner",
    async () => {
      using library = await backupLibrary('canon-unlistable-');
      await write(library, 'IMG_12.HEIC', 'pixels');
      await write(library, 'IMG_12.HEIC.xmp', maple('backup edit'));
      const id = backupPhoto(library, 'IMG_12.HEIC');
      const dir = path.join(library.root, DIR);
      await fs.chmod(dir, 0o311);
      try {
        await runTick();
      } finally {
        await fs.chmod(dir, 0o755);
      }

      expect(stamped(library, id)).toBe(false);
      expect(await read(library, 'IMG_12.HEIC.xmp')).toBe(maple('backup edit'));
    },
  );

  it('stamps a photo whose folder is gone while its volume is mounted', async () => {
    using library = await backupLibrary('canon-gone-');
    const id = seedAsset(library.db, {
      phassetDevices: ['phone'],
      location: { libraryId: library.folderId, path: '2024/Gone', filename: 'IMG_13.HEIC' },
    });

    await runTick();

    expect(stamped(library, id)).toBe(true);
  });

  it('counts down to nothing remaining once every backup photo is handled', async () => {
    using library = await backupLibrary('canon-count-');
    await write(library, 'IMG_7.HEIC', 'pixels');
    await write(library, 'IMG_7.HEIC.xmp', maple('backup edit'));
    backupPhoto(library, 'IMG_7.HEIC');
    const migration = getMigration(MIGRATION_ID)!;
    expect(await migration.countRemaining()).toBe(1);

    await runTick();

    expect(await migration.countRemaining()).toBe(0);
  });
});
