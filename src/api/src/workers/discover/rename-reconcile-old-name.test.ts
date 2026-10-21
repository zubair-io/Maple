/**
 * A photo renamed outside Maple carries its pre-#5021 `IMG.dng.xmp` backup edit
 * (#5063), so the canonical-backup-sidecars migration still finds it. Real
 * files through the real sweep and migration batch.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from '../../fs/mirrored.ts';
import * as xmpConflict from '../../fs/xmp-conflict.ts';
import { readExif } from '../../indexer/exif.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { canonicalBackupSidecars } from '../migration/canonical-backup-sidecars.ts';
import { assetIdAt, createDiscoverLibrary, type DiscoverLibrary } from './discover.test-helpers.ts';
import { makeExifTiff, onlyLocation, sweepOnce } from './rename-reconcile.test-helpers.ts';
import { moveLegacySidecarIfPresent } from './rename-reconcile-sidecar.ts';

/** A case-sensitive temp volume keeps `img.dng.xmp` and `IMG.dng.xmp` apart. */
async function caseSensitiveTmp(): Promise<boolean> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'case-probe-'));
  try {
    await writeFile(path.join(dir, 'a'), '');
    return !(await lstat(path.join(dir, 'A')).then(
      () => true,
      () => false,
    ));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const caseSensitive = await caseSensitiveTmp();

const edit = '<x:xmpmeta xmlns:papp="http://ns.justmaple.app/photo/1.0/">backup</x:xmpmeta>';

/** A backed-up `IMG_0001.dng` with an old-name edit, renamed outside Maple to `trip.dng`. */
async function renamedWithOldNameEdit(library: DiscoverLibrary, occupant?: string) {
  const bytes = makeExifTiff({ captureDate: '2024:08:11 09:00:00', serial: 'CAM-OLD-NAME' });
  const oldAbs = path.join(library.root, 'IMG_0001.dng');
  await writeFile(oldAbs, bytes);
  await sweepOnce(library, 1);
  const id = assetIdAt(library.db, '', 'IMG_0001.dng')!;
  const exif = JSON.stringify(await readExif(oldAbs));
  library.db.run(`UPDATE assets SET exif = json(?) WHERE id = ?`, [exif, id]);
  library.db.run(
    `INSERT INTO asset_phasset_links (asset_id, device_id, phasset_local_id, first_seen)
     VALUES (?, 'phone', 'P1', '2026-01-01T00:00:00.000Z')`,
    [id],
  );
  await writeFile(`${oldAbs}.xmp`, edit);
  if (occupant !== undefined) await writeFile(path.join(library.root, 'trip.dng.xmp'), occupant);
  await rm(oldAbs);
  await writeFile(path.join(library.root, 'trip.dng'), bytes);
  await sweepOnce(library, 2);
  expect(onlyLocation(library, id).filename).toBe('trip.dng');
  return oldAbs;
}

describe('rename reconciliation — old-name backup edits (#5063)', () => {
  it('carries the edit, so the migration lands it at the new canonical name', async () => {
    using library = await createDiscoverLibrary('maple-rename-old-name-');
    const oldAbs = await renamedWithOldNameEdit(library);
    setLibraryRootsForTests(new Map([[library.folderId.toHexString(), library.root]]));
    await canonicalBackupSidecars.runBatch(50).finally(() => setLibraryRootsForTests(null));

    expect(await readFile(path.join(library.root, 'trip.xmp'), 'utf8')).toBe(edit);
    await expect(stat(`${oldAbs}.xmp`)).rejects.toThrow();
  });

  it('never overwrites an old-name file already at the new name; the edit lands as a conflict copy', async () => {
    using library = await createDiscoverLibrary('maple-rename-old-name-taken-');
    const oldAbs = await renamedWithOldNameEdit(library, 'occupant');

    expect(await readFile(path.join(library.root, 'trip.dng.xmp'), 'utf8')).toBe('occupant');
    expect(await readFile(path.join(library.root, 'trip (conflict from rename).xmp'), 'utf8')).toBe(
      edit,
    );
    await expect(stat(`${oldAbs}.xmp`)).rejects.toThrow();
  });

  it('an identical old-name file already at the new name needs no conflict copy', async () => {
    using library = await createDiscoverLibrary('maple-rename-old-name-same-');
    const oldAbs = await renamedWithOldNameEdit(library, edit);

    expect(await readFile(path.join(library.root, 'trip.dng.xmp'), 'utf8')).toBe(edit);
    await expect(
      stat(path.join(library.root, 'trip (conflict from rename).xmp')),
    ).rejects.toThrow();
    await expect(stat(`${oldAbs}.xmp`)).rejects.toThrow();
  });

  it('a conflict name taken in a race moves on to the next free one', async () => {
    using library = await createDiscoverLibrary('maple-rename-old-name-race-');
    const raced = path.join(library.root, 'trip (conflict from rename).xmp');
    const pick = spyOn(xmpConflict, 'pickFreeConflictPath').mockImplementationOnce(async () => {
      await writeFile(raced, 'another writer');
      return raced;
    });
    try {
      const oldAbs = await renamedWithOldNameEdit(library, 'occupant');

      expect(await readFile(raced, 'utf8')).toBe('another writer');
      expect(
        await readFile(path.join(library.root, 'trip (conflict from rename) (2).xmp'), 'utf8'),
      ).toBe(edit);
      await expect(stat(`${oldAbs}.xmp`)).rejects.toThrow();
    } finally {
      pick.mockRestore();
    }
  });

  it('carries an old-name edit stored in a different case', async () => {
    using library = await createDiscoverLibrary('maple-rename-old-name-case-');
    const bytes = makeExifTiff({ captureDate: '2024:08:11 09:00:00', serial: 'CAM-OLD-NAME' });
    const oldAbs = path.join(library.root, 'IMG_0001.dng');
    await writeFile(oldAbs, bytes);
    await sweepOnce(library, 1);
    const id = assetIdAt(library.db, '', 'IMG_0001.dng')!;
    const exif = JSON.stringify(await readExif(oldAbs));
    library.db.run(`UPDATE assets SET exif = json(?) WHERE id = ?`, [exif, id]);
    await writeFile(path.join(library.root, 'img_0001.dng.xmp'), edit);
    await rm(oldAbs);
    await writeFile(path.join(library.root, 'trip.dng'), bytes);
    await sweepOnce(library, 2);

    expect(onlyLocation(library, id).filename).toBe('trip.dng');
    expect(await readFile(path.join(library.root, 'trip.dng.xmp'), 'utf8')).toBe(edit);
    await expect(stat(path.join(library.root, 'img_0001.dng.xmp'))).rejects.toThrow();
  });

  it("a case-only rename keeps the edit as the photo's own old-name file", async () => {
    using library = await createDiscoverLibrary('maple-rename-old-name-case-only-');
    await writeFile(path.join(library.root, 'img_0002.dng.xmp'), edit);

    await moveLegacySidecarIfPresent(
      path.join(library.root, 'img_0002.dng'),
      path.join(library.root, 'IMG_0002.dng'),
      library.root,
    );

    const names = await readdir(library.root);
    expect(names.some((name) => name.includes('conflict'))).toBe(false);
    expect(names.filter((name) => name.toLowerCase() === 'img_0002.dng.xmp')).toHaveLength(1);
  });

  it.skipIf(!caseSensitive)(
    "a case-only rename never replaces another tool's file at the new spelling",
    async () => {
      using library = await createDiscoverLibrary('maple-rename-old-name-case-occupied-');
      const darktable = '<x:xmpmeta xmlns:darktable="http://darktable.sf.net/"/>';
      await writeFile(path.join(library.root, 'img_0003.dng.xmp'), edit);
      await writeFile(path.join(library.root, 'IMG_0003.dng.xmp'), darktable);
      await writeFile(path.join(library.root, 'IMG_0003.dng'), 'pixels');

      await moveLegacySidecarIfPresent(
        path.join(library.root, 'img_0003.dng'),
        path.join(library.root, 'IMG_0003.dng'),
        library.root,
      );

      expect(await readFile(path.join(library.root, 'IMG_0003.dng.xmp'), 'utf8')).toBe(darktable);
      expect(
        await readFile(path.join(library.root, 'IMG_0003 (conflict from rename).xmp'), 'utf8'),
      ).toBe(edit);
    },
  );

  it('a rename that changes only the Unicode form keeps the edit', async () => {
    using library = await createDiscoverLibrary('maple-rename-old-name-nfd-');
    const decomposed = 'cafe\u0301.dng';
    const composed = decomposed.normalize('NFC');
    await writeFile(path.join(library.root, `${decomposed}.xmp`), edit);
    await writeFile(path.join(library.root, composed), 'pixels');

    await moveLegacySidecarIfPresent(
      path.join(library.root, decomposed),
      path.join(library.root, composed),
      library.root,
    );

    const edits = (await readdir(library.root)).filter((name) => name.endsWith('.xmp'));
    expect(edits).toHaveLength(1);
    expect(await readFile(path.join(library.root, edits[0]!), 'utf8')).toBe(edit);
  });

  // tmpdir() is behind a symlink on macOS; ownership must still hold for the lexical name.
  it("never takes the edit of a file that owns that name, such as IMG_0001.dng.JPG's", async () => {
    using library = await createDiscoverLibrary('maple-rename-old-name-owned-');
    await writeFile(path.join(library.root, 'IMG_0001.dng.JPG'), 'export');
    const oldAbs = await renamedWithOldNameEdit(library);

    expect(await readFile(`${oldAbs}.xmp`, 'utf8')).toBe(edit);
    await expect(stat(path.join(library.root, 'trip.dng.xmp'))).rejects.toThrow();
  });
});
