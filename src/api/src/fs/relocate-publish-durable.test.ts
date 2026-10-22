/**
 * The exclusive copy that `publishExclusive` falls back to where hard links
 * aren't supported (SMB, exFAT) flushes the published file before it reports
 * success (#5152): a staged temp's fsync doesn't cover a separate copy.
 * Real files in a temp directory.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as mirroredFs from './mirrored.ts';
import { mkdtemp, readFile, rm, writeFile } from './mirrored.ts';
import { publishExclusive, copyVerifiedIntoPlace } from './relocate-publish.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'relocate-publish-durable-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a copy published where links are refused is flushed before it counts', async () => {
  const staged = path.join(dir, 'staged.tmp');
  const destination = path.join(dir, 'photo.xmp');
  await writeFile(staged, 'edit');
  const link = spyOn(mirroredFs, 'link').mockRejectedValue(
    Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
  );
  const flushed: string[] = [];
  const realOpen = mirroredFs.open;
  const open = spyOn(mirroredFs, 'open').mockImplementation((async (
    ...args: Parameters<typeof realOpen>
  ) => {
    const handle = await realOpen(...args);
    if (String(args[0]) === destination) {
      const sync = handle.datasync.bind(handle);
      handle.datasync = async () => {
        flushed.push(destination);
        return sync();
      };
    }
    return handle;
  }) as typeof realOpen);
  try {
    await publishExclusive(staged, destination);
  } finally {
    link.mockRestore();
    open.mockRestore();
  }
  expect(flushed).toEqual([destination]);
  expect(await readFile(destination, 'utf8')).toBe('edit');
});

for (const fallback of ['sync succeeds', 'sync unsupported', 'sync I/O failure'] as const) {
  test(`a mount rejecting fdatasync falls back safely: ${fallback}`, async () => {
    const staged = path.join(dir, 'staged.tmp');
    const destination = path.join(dir, 'photo.xmp');
    await writeFile(staged, 'edit');
    const link = spyOn(mirroredFs, 'link').mockRejectedValue(
      Object.assign(new Error('no hard links'), { code: 'ENOTSUP' }),
    );
    const realOpen = mirroredFs.open;
    const calls: string[] = [];
    const open = spyOn(mirroredFs, 'open').mockImplementation((async (
      ...args: Parameters<typeof realOpen>
    ) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === destination) {
        handle.datasync = async () => {
          calls.push('datasync');
          throw Object.assign(new Error('unsupported'), { code: 'EINVAL' });
        };
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          calls.push('sync');
          if (fallback === 'sync succeeds') return sync();
          throw Object.assign(new Error(fallback), {
            code: fallback === 'sync unsupported' ? 'ENOTSUP' : 'EIO',
          });
        };
      }
      return handle;
    }) as typeof realOpen);
    try {
      if (fallback === 'sync I/O failure') {
        await expect(publishExclusive(staged, destination)).rejects.toThrow('sync I/O failure');
        await expect(readFile(destination)).rejects.toThrow();
      } else {
        await publishExclusive(staged, destination);
        expect(await readFile(destination, 'utf8')).toBe('edit');
      }
      expect(calls).toEqual(['datasync', 'sync']);
      expect(await readFile(staged, 'utf8')).toBe('edit');
    } finally {
      link.mockRestore();
      open.mockRestore();
    }
  });
}

test.each([false, true])(
  'a staged-copy flush failure leaves the source and destination intact (replace: %p)',
  async (replace) => {
    const source = path.join(dir, 'source.dng');
    const destination = path.join(dir, 'destination.dng');
    await writeFile(source, 'original');
    await writeFile(destination, 'occupant');
    const realOpen = mirroredFs.open;
    const open = spyOn(mirroredFs, 'open').mockImplementation((async (
      ...args: Parameters<typeof realOpen>
    ) => {
      const handle = await realOpen(...args);
      if (String(args[0]).startsWith(destination + '.tmp.')) {
        handle.datasync = async () => {
          throw Object.assign(new Error('staged copy flush failed'), { code: 'EIO' });
        };
      }
      return handle;
    }) as typeof realOpen);
    try {
      const publications: Awaited<ReturnType<typeof publishExclusive>>[] = [];
      await expect(
        copyVerifiedIntoPlace(source, destination, replace, publications),
      ).rejects.toThrow('staged copy flush failed');
      expect(publications).toHaveLength(0);
      expect(await readFile(source, 'utf8')).toBe('original');
      expect(await readFile(destination, 'utf8')).toBe('occupant');
      expect((await mirroredFs.readdir(dir)).sort()).toEqual(['destination.dng', 'source.dng']);
    } finally {
      open.mockRestore();
    }
  },
);
