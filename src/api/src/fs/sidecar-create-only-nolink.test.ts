/**
 * A create-only sidecar write on a volume that refuses hard links (#5151):
 * SMB and exFAT answer `link` with EXDEV/EPERM/ENOTSUP, not EEXIST, so the
 * write must still create an absent sidecar, and still never replace one.
 * Real files in a temp library.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import * as mirroredFs from './mirrored.ts';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from './mirrored.ts';
import { writeXmpWithPrecondition } from './xmp.ts';

let oldRoots: string | undefined;
let root: string;

beforeEach(async () => {
  oldRoots = process.env.MAPLE_ROOTS;
  root = await realpath(await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'maple-create-only-')));
  process.env.MAPLE_ROOTS = root;
});

afterEach(async () => {
  if (oldRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = oldRoots;
  await rm(root, { recursive: true, force: true });
});

function refuseLinks() {
  return spyOn(mirroredFs, 'link').mockRejectedValue(
    Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
  );
}

test('a create-only write creates an absent sidecar where hard links are refused', async () => {
  const raw = join(root, 'IMG.HEIC');
  await writeFile(raw, 'pixels');
  const link = refuseLinks();
  try {
    const outcome = await writeXmpWithPrecondition(
      raw,
      '<x:xmpmeta>new</x:xmpmeta>',
      null,
      'iPad',
      true,
    );
    expect(outcome.kind).toBe('ok');
    expect(link).toHaveBeenCalled();
  } finally {
    link.mockRestore();
  }
  expect(await readFile(join(root, 'IMG.xmp'), 'utf8')).toBe('<x:xmpmeta>new</x:xmpmeta>');
  expect((await readdir(root)).toSorted()).toEqual(['IMG.HEIC', 'IMG.xmp']);
});

test('a create-only write still never replaces an existing sidecar where hard links are refused', async () => {
  const raw = join(root, 'IMG.HEIC');
  await writeFile(raw, 'pixels');
  await writeFile(join(root, 'IMG.xmp'), '<x:xmpmeta>existing</x:xmpmeta>');
  const link = refuseLinks();
  try {
    const outcome = await writeXmpWithPrecondition(
      raw,
      '<x:xmpmeta>new</x:xmpmeta>',
      null,
      'iPad',
      true,
    );
    expect(outcome.kind).toBe('conflict');
    expect(link).toHaveBeenCalled();
  } finally {
    link.mockRestore();
  }
  expect(await readFile(join(root, 'IMG.xmp'), 'utf8')).toBe('<x:xmpmeta>existing</x:xmpmeta>');
  expect((await readdir(root)).toSorted()).toEqual([
    'IMG (conflict from iPad).xmp',
    'IMG.HEIC',
    'IMG.xmp',
  ]);
});
