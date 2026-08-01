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
});
