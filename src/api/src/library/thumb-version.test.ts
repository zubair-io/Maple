import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as fs from '../fs/mirrored.ts';
import { resolveThumbPath } from '../fs/xmp.ts';
import {
  listedThumbs,
  listingThumbStat,
  memoizedDirectorySafety,
  primaryThumbVersion,
} from './thumb-version.ts';

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

describe('listedThumbs #6109', () => {
  it('rules out a thumb the folder does not hold and keeps one it does', async () => {
    await photo('a.jpg');
    const thumbs = await listedThumbs(dir, true);
    expect(thumbs?.mayHold('a.jpg.avif')).toBe(true);
    expect(thumbs?.mayHold('b.jpg.avif')).toBe(false);
  });

  it('holds nothing when the folder has no thumbs directory', async () => {
    const thumbs = await listedThumbs(dir, true);
    expect(thumbs?.mayHold('a.jpg.avif')).toBe(false);
  });

  it.each([
    ['Caf\u00e9.JPG', 'caf\u00e9.jpg.AVIF'],
    ['Caf\u00e9.JPG', 'Cafe\u0301.JPG.avif'],
    ['STRASSE.JPG', 'stra\u00dfe.jpg.avif'],
    ['STRASSE.JPG', 'STRA\u1e9eE.JPG.avif'],
    ['PROFILE.JPG', 'pro\ufb01le.jpg.avif'],
    ['5\u03bcm.jpg', '5\u00b5m.jpg.avif'],
    [
      '\u0394\u0399\u0391\u039a\u039f\u03a0\u0395\u03a3.JPG',
      '\u03b4\u03b9\u03b1\u03ba\u03bf\u03c0\u03b5\u03c3.jpg.avif',
    ],
    [
      '\u03b4\u03b9\u03b1\u03ba\u03bf\u03c0\u03b5\u03c2.jpg',
      '\u0394\u0399\u0391\u039a\u039f\u03a0\u0395\u03a3.JPG.avif',
    ],
  ])(
    'keeps the thumb of %p when asked for %p, as a file system may fold both',
    async (stored, asked) => {
      await photo(stored);
      expect((await listedThumbs(dir, true))?.mayHold(asked)).toBe(true);
    },
  );

  it('still rules out a name that is not a case or Unicode variant of a listed one', async () => {
    await photo('Caf\u00e9.JPG');
    expect((await listedThumbs(dir, true))?.mayHold('Cafe.JPG.avif')).toBe(false);
  });

  it('rules nothing out and reads nothing for a page of a folder', async () => {
    await photo('a.jpg');
    const reading = spyOn(fs, 'readdir');
    try {
      const thumbs = await listedThumbs(dir, false);
      expect(thumbs?.mayHold('never-listed.jpg.avif')).toBe(true);
      expect(reading).not.toHaveBeenCalled();
    } finally {
      reading.mockRestore();
    }
  });

  it('rules nothing out when the thumbs directory cannot be read', async () => {
    await photo('a.jpg');
    const thumbsFolder = join(dir, '.maple', 'thumbs');
    const real = fs.readdir;
    const reading = spyOn(fs, 'readdir').mockImplementation(((
      folder: string,
      ...rest: unknown[]
    ) =>
      folder === thumbsFolder
        ? Promise.reject(Object.assign(new Error('input/output error'), { code: 'EIO' }))
        : (real as (...args: unknown[]) => unknown)(folder, ...rest)) as typeof fs.readdir);
    try {
      const thumbs = await listedThumbs(dir, true);
      expect(reading.mock.calls.filter(([folder]) => folder === thumbsFolder)).toHaveLength(1);
      expect(thumbs?.mayHold('never-listed.jpg.avif')).toBe(true);
    } finally {
      reading.mockRestore();
    }
  });

  it('is null under a symlinked .maple directory, which the route refuses, without reading it', async () => {
    const elsewhere = await fs.mkdtemp(join(tmpdir(), 'maple-listed-thumbs-elsewhere-'));
    try {
      await fs.mkdir(join(elsewhere, 'thumbs'), { recursive: true });
      await fs.writeFile(join(elsewhere, 'thumbs', 'a.jpg.avif'), 'thumb');
      await fs.symlink(elsewhere, join(dir, '.maple'));
      const reading = spyOn(fs, 'readdir');
      try {
        expect(await listedThumbs(dir, true)).toBeNull();
        expect(await listedThumbs(dir, false)).toBeNull();
        expect(reading).not.toHaveBeenCalled();
      } finally {
        reading.mockRestore();
      }
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('listingThumbStat #6109', () => {
  it('does not check a thumb the listing ruled out', async () => {
    const source = await photo('a.jpg');
    const checking = spyOn(fs, 'lstat');
    try {
      expect(await listingThumbStat(source, { mayHold: () => false })).toBeNull();
      expect(checking).not.toHaveBeenCalled();
      expect((await listingThumbStat(source, { mayHold: () => true }))?.size).toBe(5);
      expect(checking).toHaveBeenCalledTimes(1);
    } finally {
      checking.mockRestore();
    }
  });

  it('asks about the thumb by its file name', async () => {
    const source = await photo('a.jpg');
    const asked: string[] = [];
    await listingThumbStat(source, { mayHold: (name) => asked.push(name) > 0 });
    expect(asked).toEqual(['a.jpg.avif']);
  });
});
