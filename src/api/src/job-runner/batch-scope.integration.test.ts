/** Real roots, sidecars and Mongo: exercise the same scope path used when queueing. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
// Symlink setup is deliberately confined to temporary authorization fixtures.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, parse } from 'node:path';
import type { MongoClient } from 'mongodb';
import { closeDb, getDb } from '../db/client.ts';
import { tryConnectTestMongo, withTestDb } from '../db/test-db.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { batchScopes } from './batch-scope.ts';

withTestDb(`maple_test_batch_scope_${process.pid}`);
let mongo: MongoClient | null = null;
let fixture = '';
let previousRoots: string | undefined;
const patch = { attributes: { 'crs:Exposure2012': '1.25' }, elements: {} };

beforeAll(async () => {
  mongo = await tryConnectTestMongo();
  await closeDb();
  invalidateLibraryRoots();
  if (mongo) await (await getDb()).collection('folders').deleteMany({});
});
beforeEach(async () => {
  previousRoots = process.env.MAPLE_ROOTS;
  fixture = await mkdtemp(join(tmpdir(), 'maple-batch-scope-'));
});
afterEach(async () => {
  if (previousRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = previousRoots;
  await rm(fixture, { recursive: true, force: true });
});
afterAll(async () => {
  invalidateLibraryRoots();
  await closeDb();
  await mongo?.close();
});

test('environment-only roots use the native path-list delimiter throughout batch authorization', async () => {
  if (!mongo) throw new Error('This regression requires MongoDB');
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
  if (!mongo) throw new Error('This regression requires MongoDB');
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
  if (!mongo) throw new Error('This regression requires MongoDB');
  const root = parse(fixture).root;
  process.env.MAPLE_ROOTS = root;
  expect(
    await batchScopes({ targets: [{ id: 'photo', path: join(fixture, 'photo.jpg') }], patch }),
  ).toEqual([await realpath(root)]);
});
