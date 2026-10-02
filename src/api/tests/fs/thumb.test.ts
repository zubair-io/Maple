import { beforeEach, afterEach, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  copyFile,
  mkdir,
  stat,
  utimes,
  symlink,
  readFile,
} from '../../src/fs/mirrored.ts';
import { maple } from 'maple';
import { thumbRoutes } from '../../src/routes/library/thumb.ts';
import { resolveThumbPath } from '../../src/fs/xmp.ts';
import { ffiPool, _createFfiPoolForTests, _setFfiPoolForTests } from '../../src/ffi/ffi-pool.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { registerLibrary } from '../helpers/assets-route-fixtures.ts';
import { invalidateLibraryRoots } from '../../src/indexer/libraries.cache.ts';

const repo = resolve(import.meta.dir, '../../../..');
const fixture = ['test_0006.DNG', 'test_0015.dng', 'test_0017.dng']
  .map((name) => join(repo, 'test-fixtures', 'raws', name))
  .find(existsSync);
const nativeAvailable = ffiPool().available();
let live: LiveTestDatabase;
let root: string;
const app = new Elysia().use(thumbRoutes);
const get = (name: string, query = '', etag?: string) =>
  app.handle(
    new Request(`http://localhost/thumb/photos/${name}${query}`, {
      headers: etag ? { 'If-None-Match': etag } : undefined,
    }),
  );

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'maple-unified-raw-thumb-')));
  live = await createLiveTestDatabase();
  registerLibrary(live.db, root, 'photos');
});
afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  await rm(root, { recursive: true, force: true });
});

it('rejects an unsupported extension before reading a cached artifact', async () => {
  await writeFile(join(root, 'notes.txt'), 'notes');
  expect((await get('notes.txt')).status).toBe(415);
});

it('rejects an original symlink outside the registered library', async () => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'maple-outside-')));
  try {
    const secret = join(outside, 'photo.dng');
    await writeFile(secret, 'private');
    await symlink(secret, join(root, 'escape.dng'));
    const response = await get('escape.dng');
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('library jail');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it('rejects encoded traversal with 400', async () => {
  expect((await get('%2e%2e%2fphoto.dng')).status).toBe(400);
});

it('keeps the derivative tier fixed when a legacy size parameter is present', async () => {
  expect((await get('notes.txt', '?size=999999')).status).toBe(415);
  expect((await get('notes.txt')).status).toBe(415);
});

it.skipIf(!nativeAvailable || !fixture)(
  'a real RAW cold render publishes a decodable canonical thumbnail and keeps its warm bytes',
  async () => {
    const source = join(root, 'fixture.dng');
    await copyFile(fixture!, source);
    const original = await readFile(source);
    const cold = await get('fixture.dng');
    expect(cold.status).toBe(200);
    expect(cold.headers.get('X-Thumb-Cache')).toBe('miss');
    const bytes = Buffer.from(await cold.arrayBuffer());
    expect((await maple(bytes).metadata()).format).toBe('heif');
    const cached = resolveThumbPath(source);
    expect(await readFile(cached)).toEqual(bytes);
    const before = await stat(cached);
    const warm = await get('fixture.dng');
    expect(warm.status).toBe(200);
    expect(warm.headers.get('X-Thumb-Cache')).toBe('hit');
    expect(Buffer.from(await warm.arrayBuffer())).toEqual(bytes);
    expect((await stat(cached)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(source)).toEqual(original);
  },
  240_000,
);

async function stageWarmThumb() {
  const source = join(root, 'fixture.dng');
  await writeFile(source, 'source');
  const cached = resolveThumbPath(source);
  await mkdir(dirname(cached), { recursive: true });
  await writeFile(cached, 'cached-thumbnail');
  return { source, cached };
}

it('serves cached RAW derivative bytes without decoding', async () => {
  await stageWarmThumb();
  const response = await get('fixture.dng');
  expect(response.status).toBe(200);
  expect(response.headers.get('X-Thumb-Cache')).toBe('hit');
  expect(await response.text()).toBe('cached-thumbnail');
});

it('a newer original cannot validate or serve stale cached bytes', async () => {
  const { source, cached } = await stageWarmThumb();
  const first = await get('fixture.dng');
  const future = (await stat(cached)).mtimeMs / 1000 + 60;
  await utimes(source, future, future);
  const unavailable = _createFfiPoolForTests({
    availableOverride: false,
    workerFactory: () => {
      throw new Error('must reject before decoding');
    },
  });
  const previous = _setFfiPoolForTests(unavailable);
  try {
    const response = await get('fixture.dng', '', first.headers.get('ETag')!);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('cached-thumbnail');
  } finally {
    _setFfiPoolForTests(previous);
  }
});
