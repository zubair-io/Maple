/**
 * `sidecarStemOwnedByAnotherFile` is the positive check a caller makes before
 * removing a photo and leaving its sidecar to another file (#5069): only a
 * distinct regular media file, or a separately named hard link, counts. Real
 * files in a temp directory.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as mirroredFs from './mirrored.ts';
import { link, lstat, mkdtemp, rm, symlink, writeFile } from './mirrored.ts';
import { sidecarStemClaimedBySibling, sidecarStemOwnedByAnotherFile } from './sidecar-ownership.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sidecar-owned-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const at = (name: string) => path.join(dir, name);

test('a real same-stem sibling owns the sidecar', async () => {
  await writeFile(at('IMG.dng'), 'raw');
  await writeFile(at('IMG.jpg'), 'jpeg');
  expect(await sidecarStemOwnedByAnotherFile(at('IMG.dng'))).toBe(true);
});

test('a regular extensionless sibling owns its stem sidecar', async () => {
  await writeFile(at('IMG.dng'), 'raw');
  await writeFile(at('IMG'), 'extensionless image');
  expect(await sidecarStemOwnedByAnotherFile(at('IMG.dng'))).toBe(true);
});

test('the photo alone has no other owner', async () => {
  await writeFile(at('IMG.dng'), 'raw');
  await writeFile(at('IMG.xmp'), 'edit');
  expect(await sidecarStemOwnedByAnotherFile(at('IMG.dng'))).toBe(false);
});

test('a broken same-stem symlink never counts as an owner', async () => {
  await writeFile(at('IMG.dng'), 'raw');
  await symlink(at('missing.jpg'), at('IMG.jpg'));
  expect(await sidecarStemClaimedBySibling(at('IMG.dng'))).toBe(true);
  expect(await sidecarStemOwnedByAnotherFile(at('IMG.dng'))).toBe(false);
});

test('the photo under its catalog spelling is not its own sibling on a case-folding volume', async () => {
  await writeFile(at('IMG.dng'), 'raw');
  const caseFolding = await lstat(at('img.DNG')).then(
    () => true,
    () => false,
  );
  if (!caseFolding) return;
  expect(await sidecarStemClaimedBySibling(at('img.DNG'))).toBe(true);
  expect(await sidecarStemOwnedByAnotherFile(at('img.DNG'))).toBe(false);
});

test('a folder that cannot be read throws rather than naming an owner', async () => {
  await expect(sidecarStemOwnedByAnotherFile(at('missing/IMG.dng'))).rejects.toThrow();
});

test('a plain file that shares the stem never owns the sidecar', async () => {
  await writeFile(at('IMG.dng'), 'raw');
  await writeFile(at('IMG.txt'), 'notes');
  expect(await sidecarStemOwnedByAnotherFile(at('IMG.dng'))).toBe(false);
});

test('a separately named hard link to the photo still owns the sidecar', async () => {
  await writeFile(at('IMG.dng'), 'raw');
  await link(at('IMG.dng'), at('IMG.raw'));
  expect(await sidecarStemOwnedByAnotherFile(at('IMG.dng'))).toBe(true);
});

test('a sibling that cannot be inspected throws rather than reading as no owner', async () => {
  await writeFile(at('IMG.dng'), 'raw');
  await writeFile(at('IMG.jpg'), 'jpeg');
  const realLstat = mirroredFs.lstat;
  const failing = spyOn(mirroredFs, 'lstat').mockImplementation(((target: string) =>
    path.basename(String(target)) === 'IMG.jpg'
      ? Promise.reject(Object.assign(new Error('i/o error'), { code: 'EIO' }))
      : realLstat(target)) as typeof mirroredFs.lstat);
  try {
    await expect(sidecarStemOwnedByAnotherFile(at('IMG.dng'))).rejects.toThrow('i/o error');
  } finally {
    failing.mockRestore();
  }
});

test.each(['regular', 'directory', 'symlink'] as const)(
  'unknown directory-entry types are resolved with lstat (%s)',
  async (kind) => {
    await writeFile(at('IMG.dng'), 'raw');
    if (kind === 'regular') await writeFile(at('IMG.jpg'), 'jpeg');
    else if (kind === 'directory') await mirroredFs.mkdir(at('IMG.jpg'));
    else await symlink(at('IMG.dng'), at('IMG.jpg'));
    const realReadDir = mirroredFs.readdir;
    const unknown = spyOn(mirroredFs, 'readdir').mockImplementation((async (
      ...args: Parameters<typeof realReadDir>
    ) => {
      const entries = await realReadDir(...args);
      for (const entry of entries) {
        entry.isFile = () => false;
        entry.isDirectory = () => false;
        entry.isSymbolicLink = () => false;
      }
      return entries;
    }) as typeof realReadDir);
    try {
      expect(await sidecarStemOwnedByAnotherFile(at('IMG.dng'))).toBe(kind === 'regular');
    } finally {
      unknown.mockRestore();
    }
  },
);
