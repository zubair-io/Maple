import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { assetsRoutes } from '../assets.ts';
import { registerLibrary, seedRouteAsset } from '../../../tests/helpers/assets-route-fixtures.ts';

const app = new Elysia().use(assetsRoutes);
const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/" />';
let live: LiveTestDatabase;
let originalMapleRoots: string | undefined;
let root: string;
let assetId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  originalMapleRoots = process.env.MAPLE_ROOTS;
  root = await realpath(await mkdtemp(join(tmpdir(), 'maple-xmp-cancellation-')));
  process.env.MAPLE_ROOTS = root;
  const libraryId = registerLibrary(live.db, root);
  assetId = seedRouteAsset(live.db, {
    libraryId,
    path: '',
    filename: 'cancel.dng',
    size: 8,
  });
  await writeFile(join(root, 'cancel.dng'), Buffer.alloc(8));
  await writeFile(join(root, 'cancel.xmp'), xml);
});

afterEach(async () => {
  if (originalMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = originalMapleRoots;
  invalidateLibraryRoots();
  live.close();
  await rm(root, { recursive: true, force: true });
});

test('id-keyed PUT forwards request cancellation before publishing a sidecar', async () => {
  const controller = new AbortController();
  const responsePromise = app.handle(
    new Request(`http://localhost/api/assets/${assetId}/xmp`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/xml' },
      body: xml.replace('/>', ' crs:Exposure2012="1" />'),
      signal: controller.signal,
    }),
  );
  controller.abort();

  const response = await responsePromise;
  expect(response.status).toBe(500);
  expect(await readFile(join(root, 'cancel.xmp'), 'utf8')).toBe(xml);
});
