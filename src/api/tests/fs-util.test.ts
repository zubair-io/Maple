import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicMove, filesIdentical, firstFreeSiblingPath } from '../src/backup/fs-util.ts';

// Mongo-free unit coverage for the backup filesystem helpers. The end-to-end
// path-collision behaviour lives in backup-ingest-errors.test.ts (which needs
// a live MongoDB); this exercises the comparison + disambiguation logic on its
// own so it runs on any CI runner.

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-fs-util-test-'));
});
afterAll(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('filesIdentical', () => {
  test('same size, same bytes → true', async () => {
    const a = path.join(dir, 'a.bin');
    const b = path.join(dir, 'b.bin');
    await fs.writeFile(a, Buffer.alloc(4096, 7));
    await fs.writeFile(b, Buffer.alloc(4096, 7));
    expect(await filesIdentical(a, b)).toBe(true);
  });

  test('same size, different bytes → false', async () => {
    const a = path.join(dir, 'c.bin');
    const b = path.join(dir, 'd.bin');
    await fs.writeFile(a, Buffer.alloc(64, 0));
    await fs.writeFile(b, Buffer.alloc(64, 11));
    expect(await filesIdentical(a, b)).toBe(false);
  });

  test('different size → false', async () => {
    const a = path.join(dir, 'e.bin');
    const b = path.join(dir, 'f.bin');
    await fs.writeFile(a, Buffer.alloc(64, 1));
    await fs.writeFile(b, Buffer.alloc(65, 1));
    expect(await filesIdentical(a, b)).toBe(false);
  });

  test('both empty → true', async () => {
    const a = path.join(dir, 'g.bin');
    const b = path.join(dir, 'h.bin');
    await fs.writeFile(a, Buffer.alloc(0));
    await fs.writeFile(b, Buffer.alloc(0));
    expect(await filesIdentical(a, b)).toBe(true);
  });

  test('multi-chunk content where only the tail differs → false', async () => {
    // Larger than the 64 KiB read chunk so the streaming loop iterates.
    const big = 200 * 1024;
    const a = path.join(dir, 'big-a.bin');
    const b = path.join(dir, 'big-b.bin');
    const bufA = Buffer.alloc(big, 3);
    const bufB = Buffer.alloc(big, 3);
    bufB[big - 1] = 9; // flip the very last byte
    await fs.writeFile(a, bufA);
    await fs.writeFile(b, bufB);
    expect(await filesIdentical(a, b)).toBe(false);
  });
});

describe('firstFreeSiblingPath', () => {
  test('returns -1 sibling when the base path is occupied', async () => {
    const sub = path.join(dir, '2024/07/04');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'IMG.HEIC'), Buffer.alloc(1));
    const free = await firstFreeSiblingPath(dir, '2024/07/04/IMG.HEIC');
    expect(free.relPath).toBe('2024/07/04/IMG-1.HEIC');
    expect(free.absPath).toBe(path.join(dir, '2024', '07', '04', 'IMG-1.HEIC'));
  });

  test('skips occupied siblings to the next free index', async () => {
    const sub = path.join(dir, '2024/08/09');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'P.JPG'), Buffer.alloc(1));
    await fs.writeFile(path.join(sub, 'P-1.JPG'), Buffer.alloc(1));
    await fs.writeFile(path.join(sub, 'P-2.JPG'), Buffer.alloc(1));
    const free = await firstFreeSiblingPath(dir, '2024/08/09/P.JPG');
    expect(free.relPath).toBe('2024/08/09/P-3.JPG');
  });

  test('handles a bare filename (no directory)', async () => {
    await fs.writeFile(path.join(dir, 'bare.dng'), Buffer.alloc(1));
    const free = await firstFreeSiblingPath(dir, 'bare.dng');
    expect(free.relPath).toBe('bare-1.dng');
    expect(free.absPath).toBe(path.join(dir, 'bare-1.dng'));
  });
});

describe('atomicMove', () => {
  test('moves a file to a fresh destination', async () => {
    const src = path.join(dir, 'move-src.bin');
    const dst = path.join(dir, 'moved/move-dst.bin');
    await fs.writeFile(src, Buffer.alloc(32, 5));
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await atomicMove(src, dst);
    expect((await fs.readFile(dst)).equals(Buffer.alloc(32, 5))).toBe(true);
    let srcGone = false;
    try {
      await fs.stat(src);
    } catch {
      srcGone = true;
    }
    expect(srcGone).toBe(true);
  });
});
