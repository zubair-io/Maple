import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as fs from '../fs/mirrored.ts';
import { resolveThumbPath } from '../fs/xmp.ts';
import { memoizedDirectorySafety, primaryThumbVersion } from './thumb-version.ts';

let dir: string;
const past = new Date('2026-01-01T00:00:00Z');
const later = new Date('2026-02-01T00:00:00Z');

async function photo(name: string, thumbTime = later): Promise<string> {
  const source = join(dir, name);
  await fs.writeFile(source, 'x');
  await fs.utimes(source, past, past);
  const thumb = resolveThumbPath(source);
  await fs.mkdir(dirname(thumb), { recursive: true });
  await fs.writeFile(thumb, 'thumb');
  await fs.utimes(thumb, thumbTime, thumbTime);
  return source;
}

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-primary-thumb-version-')));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('primaryThumbVersion #6016', () => {
  it('names a thumb newer than its original and sidecar', async () => {
    const source = await photo('a.jpg');
    expect(await primaryThumbVersion(source, memoizedDirectorySafety())).toBeString();
  });

  it('changes when the thumb is rewritten', async () => {
    const source = await photo('a.jpg');
    const before = await primaryThumbVersion(source, memoizedDirectorySafety());
    const rerender = new Date('2026-03-01T00:00:00Z');
    await fs.writeFile(resolveThumbPath(source), 'thumb, re-rendered');
    await fs.utimes(resolveThumbPath(source), rerender, rerender);
    expect(await primaryThumbVersion(source, memoizedDirectorySafety())).not.toBe(before);
  });

  it('is null once the sidecar is newer than the thumb', async () => {
    const source = await photo('a.jpg');
    const sidecar = join(dir, 'a.xmp');
    await fs.writeFile(sidecar, '<x/>');
    const edited = new Date('2026-03-01T00:00:00Z');
    await fs.utimes(sidecar, edited, edited);
    expect(await primaryThumbVersion(source, memoizedDirectorySafety())).toBeNull();
  });

  it('is null when the original is gone', async () => {
    const source = await photo('a.jpg');
    await fs.rm(source);
    expect(await primaryThumbVersion(source, memoizedDirectorySafety())).toBeNull();
  });

  it('is null when the volume does not answer in time', async () => {
    const source = await photo('a.jpg');
    const stalled = () => new Promise<boolean>(() => {});
    const started = performance.now();
    expect(await primaryThumbVersion(source, stalled)).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('is null under a symlinked .maple directory, which the route refuses', async () => {
    const elsewhere = await fs.mkdtemp(join(tmpdir(), 'maple-primary-thumb-elsewhere-'));
    try {
      const source = join(dir, 'a.jpg');
      await fs.writeFile(source, 'x');
      await fs.utimes(source, past, past);
      await fs.mkdir(join(elsewhere, 'thumbs'), { recursive: true });
      await fs.writeFile(join(elsewhere, 'thumbs', 'a.jpg.avif'), 'thumb');
      await fs.symlink(elsewhere, join(dir, '.maple'));
      expect(await primaryThumbVersion(source, memoizedDirectorySafety())).toBeNull();
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });
});
