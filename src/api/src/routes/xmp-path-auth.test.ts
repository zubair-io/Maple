import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';
import { resolveAndAuthorizePath } from './xmp-path-auth.ts';

let oldRoots: string | undefined;
let root: string;
let nested: string;

beforeEach(async () => {
  oldRoots = process.env.MAPLE_ROOTS;
  root = await realpath(await mkdtemp(join(tmpdir(), 'maple-xmp-path-auth-')));
  nested = join(root, 'nested');
  await mkdir(nested);
  process.env.MAPLE_ROOTS = '';
  setLibraryRootsForTests(
    new Map([
      ['outer', root],
      ['inner', nested],
    ]),
  );
});

afterEach(async () => {
  if (oldRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = oldRoots;
  setLibraryRootsForTests(null);
  await rm(root, { recursive: true, force: true });
});

test('nested registered paths use the broadest matching library for write admission', async () => {
  const filePath = join(nested, 'photo.dng');
  const result = await resolveAndAuthorizePath(filePath);

  expect(result).toEqual({
    ok: true,
    data: filePath,
    writeScope: root,
  });
});
