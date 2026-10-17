/**
 * Workflow variant endpoints refuse a variant sidecar that is a symlink to
 * the original (#4749). Split out of xmp.workflow.test.ts to keep that file
 * under the line budget; the harness mirrors it.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shutdownMaplePool } from 'maple';
import { xmpPathRoutes } from './xmp';
import { setLibraryRootsForTests } from '../indexer/libraries.cache';

const corpus = JSON.parse(
  await readFile(
    new URL('../../../../test-fixtures/workflow/contract-v1.json', import.meta.url),
    'utf8',
  ),
);
const xml = await readFile(
  new URL('../../../../test-fixtures/local-adjustments/lightroom-group-add.xmp', import.meta.url),
  'utf8',
);
const app = new Elysia().use(xmpPathRoutes);
const oldRoots = process.env.MAPLE_ROOTS;
let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-workflow-symlink-')));
  process.env.MAPLE_ROOTS = directory;
  setLibraryRootsForTests(new Map([['workflow-symlink-fixture', directory]]));
  await writeFile(join(directory, 'photo.dng'), new Uint8Array([1, 0, 255, 42]));
  await writeFile(join(directory, 'photo.xmp'), xml);
});
afterEach(async () => {
  shutdownMaplePool();
  setLibraryRootsForTests(null);
  if (oldRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = oldRoots;
  await rm(directory, { recursive: true, force: true });
});

const variantQuery = () => 'path=' + encodeURIComponent(join(directory, 'photo.dng'));
const variantGet = (route: string) => app.handle(new Request(`http://localhost/api/xmp/${route}`));
const variantSend = (route: string, method: 'POST' | 'PUT', body: unknown) =>
  app.handle(
    new Request(`http://localhost/api/xmp/${route}`, {
      method,
      headers: { 'Content-Type': method === 'POST' ? 'application/json' : 'application/xml' },
      body: method === 'POST' ? JSON.stringify(body) : String(body),
    }),
  );

test('a variant sidecar symlinked to the original is refused, not read (#4749)', async () => {
  const first = corpus[1];
  expect((await variantSend('variants?' + variantQuery(), 'POST', first)).status).toBe(201);
  const filename = join(directory, `photo.v${first.variantId}.xmp`);
  await unlink(filename);
  await symlink(join(directory, 'photo.dng'), filename);
  const selected = 'variant?' + variantQuery() + '&variantId=' + first.variantId;
  expect((await variantGet(selected)).status).toBe(403);
  expect((await variantSend(selected, 'PUT', xml)).status).toBe(403);
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});
