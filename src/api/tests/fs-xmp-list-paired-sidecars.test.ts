import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as realFs from 'node:fs';
import * as fs from '../src/fs/mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { listPairedSidecars, listPairedSidecarsStrict } from '../src/fs/xmp-conflict.ts';
import { sidecarRenameTarget } from '../src/fs/sidecar-rename.ts';
import {
  oldNameEditUnlisted,
  pairedLegacyBackupSidecar,
  readLegacyAt,
} from '../src/fs/legacy-backup-sidecar.ts';

/** Whether the temp volume keeps `A` and `a` apart (APFS folds case; CI's ext4 doesn't). */
const caseSensitiveTmp = (() => {
  const probe = realFs.mkdtempSync(path.join(os.tmpdir(), 'maple-case-probe-'));
  realFs.writeFileSync(path.join(probe, 'A'), '');
  const sensitive = !realFs.existsSync(path.join(probe, 'a'));
  realFs.rmSync(probe, { recursive: true, force: true });
  return sensitive;
})();

const normalizationSensitiveTmp = (() => {
  const probe = realFs.mkdtempSync(path.join(os.tmpdir(), 'maple-nfd-probe-'));
  realFs.writeFileSync(path.join(probe, '\u00e9'), '');
  realFs.writeFileSync(path.join(probe, 'e\u0301'), '');
  const sensitive = realFs.readdirSync(probe).length === 2;
  realFs.rmSync(probe, { recursive: true, force: true });
  return sensitive;
})();

const maple = (label: string) =>
  `<x:xmpmeta xmlns:papp="http://ns.justmaple.app/photo/1.0/">${label}</x:xmpmeta>`;

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-paired-sidecars-'));
  // RAW under test.
  await fs.writeFile(path.join(tmpRoot, 'IMG_1.ARW'), 'raw');
  // Sidecars to find.
  await fs.writeFile(path.join(tmpRoot, 'IMG_1.xmp'), 'canon');
  await fs.writeFile(path.join(tmpRoot, 'IMG_1 (conflict from Mac-A).xmp'), 'ca');
  await fs.writeFile(path.join(tmpRoot, 'IMG_1 (conflict from Mac-A) (2).xmp'), 'ca2');
  await fs.writeFile(path.join(tmpRoot, 'IMG_1 (conflict from iPad).xmp'), 'ip');
  // Sidecars that must NOT be picked up.
  await fs.writeFile(path.join(tmpRoot, 'IMG_2.xmp'), 'other');
  await fs.writeFile(path.join(tmpRoot, 'IMG_1.txt'), 'not xmp');
  await fs.writeFile(path.join(tmpRoot, 'IMG_10.xmp'), 'starts-with-IMG_1 but different');
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('listPairedSidecars', () => {
  test('returns canonical + all conflict variants for the given RAW', async () => {
    const got = await listPairedSidecars(path.join(tmpRoot, 'IMG_1.ARW'));
    const names = got.map((p) => path.basename(p)).sort();
    expect(names).toEqual([
      'IMG_1 (conflict from Mac-A) (2).xmp',
      'IMG_1 (conflict from Mac-A).xmp',
      'IMG_1 (conflict from iPad).xmp',
      'IMG_1.xmp',
    ]);
  });

  test('returns empty when no sidecars exist', async () => {
    const raw = path.join(tmpRoot, 'IMG_99.ARW');
    await fs.writeFile(raw, 'x');
    const got = await listPairedSidecars(raw);
    expect(got).toEqual([]);
  });

  test("returns empty when the RAW's directory does not exist", async () => {
    const got = await listPairedSidecars('/no/such/dir/IMG_1.ARW');
    expect(got).toEqual([]);
  });

  test('does NOT match bare numeric variants like `<base> (N).xmp`', async () => {
    // Regression: the earlier pattern made BOTH the conflict-from group
    // and the numeric group optional, so `IMG_1 (2).xmp` matched as if
    // it were a paired sidecar for `IMG_1`. That would let trash/purge
    // move or delete unrelated XMP files with that name. The fix anchors
    // the numeric `(N)` suffix so it can only appear AFTER a
    // conflict-from group.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-paired-no-numeric-'));
    try {
      const raw = path.join(dir, 'IMG_1.ARW');
      await fs.writeFile(raw, 'raw');
      await fs.writeFile(path.join(dir, 'IMG_1.xmp'), 'canon');
      // Bare numeric variant — must NOT be considered paired with IMG_1.
      await fs.writeFile(path.join(dir, 'IMG_1 (2).xmp'), 'stray');
      // Conflict-from + numeric is still a paired variant.
      await fs.writeFile(path.join(dir, 'IMG_1 (conflict from Mac) (3).xmp'), 'ok');

      const got = await listPairedSidecars(raw);
      const names = got.map((p) => path.basename(p)).sort();
      expect(names).toEqual(['IMG_1 (conflict from Mac) (3).xmp', 'IMG_1.xmp']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('matches a video by its FULL-NAME sidecar, not the stem-swapped one (#1678)', async () => {
    // Videos use `clip.mov.xmp`, images use `clip.xmp`. Moving these functions
    // into this module once silently reverted that split — the moved copies
    // predated the fix — so pin it here, where the matcher now lives.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-paired-video-'));
    try {
      const mov = path.join(dir, 'clip.mov');
      await fs.writeFile(mov, 'video');
      await fs.writeFile(path.join(dir, 'clip.mov.xmp'), 'canonical');
      await fs.writeFile(path.join(dir, 'clip.mov (conflict from Mac).xmp'), 'variant');
      // The stem-swapped name belongs to a DIFFERENT asset and must not match.
      await fs.writeFile(path.join(dir, 'clip.xmp'), 'not-the-videos');

      const names = (await listPairedSidecars(mov)).map((p) => path.basename(p)).sort();
      expect(names).toEqual(['clip.mov (conflict from Mac).xmp', 'clip.mov.xmp']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a Live Photo still does not pick up its paired video sidecar (#1678)', async () => {
    // `IMG_1234.HEIC` + `IMG_1234.MOV` are two independent same-stem assets.
    // The photo must see only its own `IMG_1234.xmp`.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-paired-livephoto-'));
    try {
      const heic = path.join(dir, 'IMG_1234.HEIC');
      await fs.writeFile(heic, 'photo');
      await fs.writeFile(path.join(dir, 'IMG_1234.MOV'), 'motion');
      await fs.writeFile(path.join(dir, 'IMG_1234.xmp'), 'photo-sidecar');
      await fs.writeFile(path.join(dir, 'IMG_1234.MOV.xmp'), 'video-sidecar');

      const names = (await listPairedSidecars(heic)).map((p) => path.basename(p)).sort();
      expect(names).toEqual(['IMG_1234.xmp']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // #5063: a backup edit from before #5021 sits at `IMG.HEIC.xmp`; every mover
  // must carry it with the photo, or the migration finds nothing at the new path.
  test("pairs a photo's pre-#5021 old-name backup edit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-paired-old-name-'));
    try {
      const heic = path.join(dir, 'IMG_7.HEIC');
      await fs.writeFile(heic, 'photo');
      await fs.writeFile(path.join(dir, 'IMG_7.xmp'), maple('server edit'));
      await fs.writeFile(path.join(dir, 'IMG_7.HEIC.xmp'), maple('backup edit'));

      const names = (await listPairedSidecars(heic)).map((p) => path.basename(p)).sort();
      expect(names).toEqual(['IMG_7.HEIC.xmp', 'IMG_7.xmp']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("never pairs another tool's full-name sidecar, or one another file owns", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-paired-old-name-foreign-'));
    try {
      const heic = path.join(dir, 'IMG_8.HEIC');
      await fs.writeFile(heic, 'photo');
      await fs.writeFile(
        path.join(dir, 'IMG_8.HEIC.xmp'),
        '<x:xmpmeta xmlns:darktable="http://darktable.sf.net/"/>',
      );
      const jpeg = path.join(dir, 'IMG_9.HEIC');
      await fs.writeFile(jpeg, 'photo');
      await fs.writeFile(path.join(dir, 'IMG_9.HEIC.JPG'), 'export');
      await fs.writeFile(path.join(dir, 'IMG_9.HEIC.xmp'), maple("the export's own edit"));

      expect(await listPairedSidecars(heic)).toEqual([]);
      expect(await listPairedSidecars(jpeg)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('an old-name entry that is not a regular file is never paired', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-paired-old-name-dir-'));
    try {
      const heic = path.join(dir, 'IMG_10.HEIC');
      await fs.writeFile(heic, 'photo');
      await fs.mkdir(path.join(dir, 'IMG_10.HEIC.xmp'));

      expect(await listPairedSidecarsStrict(heic)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Root reads a mode-000 file anyway, so there is nothing to refuse.
  test.skipIf(process.getuid?.() === 0)(
    'an unreadable old-name file fails the strict listing, and only drops itself from the others',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-paired-old-name-unreadable-'));
      const legacy = path.join(dir, 'IMG_11.HEIC.xmp');
      try {
        const heic = path.join(dir, 'IMG_11.HEIC');
        await fs.writeFile(heic, 'photo');
        await fs.writeFile(path.join(dir, 'IMG_11.xmp'), maple('server edit'));
        await fs.writeFile(legacy, maple('backup edit'));
        await fs.chmod(legacy, 0o000);

        expect((await listPairedSidecars(heic)).map((p) => path.basename(p))).toEqual([
          'IMG_11.xmp',
        ]);
        await expect(listPairedSidecarsStrict(heic)).rejects.toThrow();
      } finally {
        await fs.chmod(legacy, 0o644).catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  test('an old-name edit follows its photo to the new full name', () => {
    expect(sidecarRenameTarget('/a/IMG_7.HEIC', '/b/Trip.heic', '/a/IMG_7.HEIC.xmp')).toBe(
      path.join('/b', 'Trip.heic.xmp'),
    );
    expect(sidecarRenameTarget('/a/IMG_7.HEIC', '/b/IMG_7.1.HEIC', '/a/IMG_7.HEIC.xmp')).toBe(
      path.join('/b', 'IMG_7.1.HEIC.xmp'),
    );
  });

  // Simulated listing: APFS can't hold `IMG_12.HEIC` and `IMG_12.heic` together.
  test("on a case-sensitive volume, a case variant's own old-name file is never paired", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-paired-old-name-case-'));
    try {
      await fs.writeFile(path.join(dir, 'IMG_12.heic.xmp'), maple("the variant's edit"));
      const listed = ['IMG_12.HEIC', 'IMG_12.heic', 'IMG_12.heic.xmp'];

      expect(await pairedLegacyBackupSidecar(path.join(dir, 'IMG_12.HEIC'), listed)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // tmpdir() sits behind a symlink on macOS (/var → /private/var).
  test("another file's ownership holds when the old-name path is a realpath", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-paired-old-name-realpath-'));
    try {
      const heic = path.join(dir, 'IMG_13.HEIC');
      await fs.writeFile(path.join(dir, 'IMG_13.HEIC.JPG'), 'export');
      const owned = path.join(dir, 'IMG_13.HEIC.xmp');
      await fs.writeFile(owned, maple("the export's edit"));

      expect(await readLegacyAt(heic, await fs.realpath(owned))).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!caseSensitiveTmp)(
    "another tool's exact-name file doesn't hide a Maple edit stored in another case",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-paired-old-name-masked-'));
      try {
        const heic = path.join(dir, 'IMG_14.HEIC');
        await fs.writeFile(heic, 'photo');
        await fs.writeFile(path.join(dir, 'IMG_14.HEIC.xmp'), '<x:xmpmeta xmlns:darktable="x"/>');
        await fs.writeFile(path.join(dir, 'img_14.heic.xmp'), maple('backup edit'));
        const listed = await fs.readdir(dir);

        expect(await pairedLegacyBackupSidecar(heic, listed)).toBe(
          path.join(dir, 'img_14.heic.xmp'),
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  // Root reads a mode-000 file anyway, so there is nothing to refuse.
  test.skipIf(process.getuid?.() === 0)(
    'an unreadable old-name edit stored in another case still refuses a move',
    async () => {
      const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'maple-paired-old-name-variant-unreadable-'),
      );
      const variant = path.join(dir, 'img_15.heic.xmp');
      try {
        const heic = path.join(dir, 'IMG_15.HEIC');
        await fs.writeFile(heic, 'photo');
        await fs.writeFile(variant, maple('backup edit'));
        await fs.chmod(variant, 0o000);

        expect(await oldNameEditUnlisted(heic, [])).toBe(true);
      } finally {
        await fs.chmod(variant, 0o644);
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  test('an old-name edit is returned under the name it is stored as (NFD from a Mac)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-paired-old-name-nfd-'));
    try {
      const stem = 'Cafe\u0301';
      await fs.writeFile(path.join(dir, `${stem}.HEIC`), 'photo');
      await fs.writeFile(path.join(dir, `${stem}.HEIC.xmp`), maple('backup edit'));
      const listed = await fs.readdir(dir);
      const stored = listed.find((name) => name.endsWith('.xmp'))!;

      const paired = await pairedLegacyBackupSidecar(
        path.join(dir, `${stem}.HEIC`.normalize('NFC')),
        listed,
      );

      expect(paired).toBe(path.join(dir, stored));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // ext4 keeps NFC and NFD apart: another tool's file at one spelling never hides a Maple edit at the other.
  test.skipIf(!normalizationSensitiveTmp)(
    'an old-name edit at the other Unicode spelling of a foreign file is still found',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-paired-old-name-nfc-nfd-'));
      try {
        const composed = 'Caf\u00e9.HEIC';
        const decomposed = 'Cafe\u0301.HEIC';
        await fs.writeFile(path.join(dir, composed), 'photo');
        await fs.writeFile(
          path.join(dir, `${composed}.xmp`),
          '<x:xmpmeta xmlns:darktable="http://darktable.sf.net/"/>',
        );
        await fs.writeFile(path.join(dir, `${decomposed}.xmp`), maple('backup edit'));

        const paired = await pairedLegacyBackupSidecar(
          path.join(dir, composed),
          await fs.readdir(dir),
        );

        expect(paired).toBe(path.join(dir, `${decomposed}.xmp`));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});
