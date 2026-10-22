/**
 * `sidecarStemOwnedByAnotherFile` is the positive check a caller makes before
 * removing a photo and leaving its sidecar to another file (#5069): only a
 * distinct regular file counts. Real files in a temp directory.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { lstat, mkdtemp, rm, symlink, writeFile } from './mirrored.ts';
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
