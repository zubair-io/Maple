import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { listPairedSidecars } from '../src/fs/xmp-conflict.ts';

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
});
