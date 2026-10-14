import { afterEach, beforeEach, expect, test } from 'bun:test';
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteXmpSidecar, writeXmpWithPrecondition } from './xmp.ts';

let oldRoots: string | undefined;
let root: string;

beforeEach(async () => {
  oldRoots = process.env.MAPLE_ROOTS;
  root = await realpath(await mkdtemp(join(tmpdir(), 'maple-xmp-write-')));
  process.env.MAPLE_ROOTS = root;
});

afterEach(async () => {
  if (oldRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = oldRoots;
  await rm(root, { recursive: true, force: true });
});

test('idempotent delete removes a dangling sidecar symlink without touching the original', async () => {
  const rawPath = join(root, 'dangling.dng');
  const sidecarPath = join(root, 'dangling.xmp');
  await writeFile(rawPath, Buffer.from([7, 3, 1]));
  await symlink(join(root, 'missing-target.xmp'), sidecarPath);

  expect(await deleteXmpSidecar(rawPath, root)).toEqual({ ok: true, existed: true });
  await expect(lstat(sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(rawPath)).toEqual(Buffer.from([7, 3, 1]));
});

test('precondition writes stop after request cancellation without changing the sidecar', async () => {
  const rawPath = join(root, 'photo.dng');
  const original = '<x:xmpmeta />';
  await writeFile(rawPath, Buffer.from([1, 2, 3]));
  await writeFile(join(root, 'photo.xmp'), original);
  const controller = new AbortController();
  controller.abort();

  const result = await writeXmpWithPrecondition(
    rawPath,
    '<x:xmpmeta><updated /></x:xmpmeta>',
    null,
    'test-device',
    false,
    root,
    controller.signal,
  );

  expect(result.kind).toBe('error');
  expect(await readFile(join(root, 'photo.xmp'), 'utf8')).toBe(original);
});
