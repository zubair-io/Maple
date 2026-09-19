/**
 * Real roots and sidecars: exercise the same scope path used when queueing.
 *
 * `batchScopes` unions the registered library roots with `MAPLE_ROOTS`, so
 * every case here opens a database of its own with no `folders` rows in it
 * (#3787) — that is what makes the assertions about environment-only roots
 * mean what they say. The library cache is process-wide, so it is dropped as
 * each database is installed and again as it goes away.
 */
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
// Symlink setup is deliberately confined to temporary authorization fixtures.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, parse } from 'node:path';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { batchScopes } from './batch-scope.ts';

let fixture = '';
let previousRoots: string | undefined;
const patch = { attributes: { 'crs:Exposure2012': '1.25' }, elements: {} };

/** This test's own database, with no library registered in it. */
async function emptyLibraries(): Promise<LiveTestDatabase> {
  const live = await createLiveTestDatabase();
  invalidateLibraryRoots();
  return live;
}

beforeEach(async () => {
  previousRoots = process.env.MAPLE_ROOTS;
  fixture = await mkdtemp(join(tmpdir(), 'maple-batch-scope-'));
});
afterEach(async () => {
  if (previousRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = previousRoots;
  await rm(fixture, { recursive: true, force: true });
  invalidateLibraryRoots();
});
afterAll(() => {
  invalidateLibraryRoots();
});

test('environment-only roots use the native path-list delimiter throughout batch authorization', async () => {
  using _live = await emptyLibraries();
  const roots = [join(fixture, 'first'), join(fixture, 'second')];
  await Promise.all(roots.map((root) => mkdir(root)));
  process.env.MAPLE_ROOTS = roots.join(delimiter);
  const targets = roots.map((root, index) => ({
    id: String(index),
    path: join(root, 'photo.jpg'),
  }));
  await Promise.all(targets.map((target) => writeFile(target.path, 'original sentinel')));

  expect(await batchScopes({ targets, patch })).toEqual(
    (await Promise.all(roots.map((root) => realpath(root)))).sort(),
  );
  await expect(
    batchScopes({ targets: [{ id: 'outside', path: join(fixture, 'outside.jpg') }], patch }),
  ).rejects.toThrow('not inside any registered library root');
});

test('batch queueing rejects a sidecar symlink outside its allowed root', async () => {
  using _live = await emptyLibraries();
  const root = join(fixture, 'allowed');
  await mkdir(root);
  const outside = join(fixture, 'outside.xmp');
  await writeFile(outside, '<xmpmeta/>');
  await symlink(outside, join(root, 'photo.xmp'));
  process.env.MAPLE_ROOTS = root;

  await expect(
    batchScopes({ targets: [{ id: 'photo', path: join(root, 'photo.jpg') }], patch }),
  ).rejects.toThrow('outside all registered roots');
});

test('a filesystem root authorizes descendants and owns their batch fence', async () => {
  using _live = await emptyLibraries();
  const root = parse(fixture).root;
  process.env.MAPLE_ROOTS = root;
  expect(
    await batchScopes({ targets: [{ id: 'photo', path: join(fixture, 'photo.jpg') }], patch }),
  ).toEqual([await realpath(root)]);
});
