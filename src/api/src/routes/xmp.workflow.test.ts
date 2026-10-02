import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNative, shutdownMaplePool } from 'maple';
import { xmpPathRoutes } from './xmp';
import { setLibraryRootsForTests } from '../indexer/libraries.cache';
import { writeXmpWithPrecondition } from '../fs/xmp';

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
  directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-workflow-api-')));
  process.env.MAPLE_ROOTS = directory;
  setLibraryRootsForTests(new Map([['workflow-fixture', directory]]));
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
const patch = (body: unknown) =>
  app.handle(
    new Request(
      'http://localhost/api/xmp/workflow?path=' + encodeURIComponent(join(directory, 'photo.dng')),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  );
const post = (body: string) =>
  app.handle(
    new Request(
      'http://localhost/api/xmp?path=' + encodeURIComponent(join(directory, 'photo.dng')),
      { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body },
    ),
  );

test('API uses real Rust and atomic sidecar files while preserving authored WB/checkpoints', async () => {
  const response = await patch(corpus[1]);
  expect(response.status).toBe(200);
  const output = await readFile(join(directory, 'photo.xmp'), 'utf8');
  expect(output).toBe(await response.text());
  const read = await callNative('workflowReadXmp', [output]);
  expect(read.ok).toBe(true);
  if (!read.ok) throw Error(read.error);
  expect(JSON.parse(read.value)).toEqual(corpus[1]);
  expect(output).toContain('<crs:MaskGroupBasedCorrections>');
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
  // A client with an older model must not erase newly persisted workflow data.
  expect((await post(xml)).status).toBe(200);
  const retained = await callNative('workflowReadXmp', [
    await readFile(join(directory, 'photo.xmp'), 'utf8'),
  ]);
  expect(retained).toEqual(read);
  expect(
    (await writeXmpWithPrecondition(join(directory, 'photo.dng'), xml, null, 'workflow-test')).kind,
  ).toBe('ok');
  expect(
    await callNative('workflowReadXmp', [await readFile(join(directory, 'photo.xmp'), 'utf8')]),
  ).toEqual(read);
});
test('future/malformed records leave the exact on-disk sidecar and original untouched', async () => {
  expect((await patch(corpus[0])).status).toBe(200);
  const future = (await readFile(join(directory, 'photo.xmp'), 'utf8')).replace(
    '<papp:SchemaVersion>1',
    '<papp:SchemaVersion>2',
  );
  await writeFile(join(directory, 'photo.xmp'), future);
  expect((await patch(corpus[1])).status).toBe(422);
  expect((await post(xml)).status).toBe(500);
  expect(
    (await writeXmpWithPrecondition(join(directory, 'photo.dng'), xml, null, 'workflow-test')).kind,
  ).toBe('error');
  expect(await readFile(join(directory, 'photo.xmp'), 'utf8')).toBe(future);
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});
test('invalid checkpoint and outside-root requests cannot publish', async () => {
  const invalid = {
    ...corpus[0],
    snapshots: [{ ...corpus[0].snapshots[0], adjustmentXmp: '<bad/>' }],
  };
  expect((await patch(invalid)).status).toBe(422);
  const denied = await app.handle(
    new Request('http://localhost/api/xmp/workflow?path=/outside/photo.dng', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpus[0]),
    }),
  );
  expect(denied.status).toBe(403);
  expect(await readFile(join(directory, 'photo.xmp'), 'utf8')).toBe(xml);
});

test('API creates a workflow sidecar when none exists without touching the original', async () => {
  await unlink(join(directory, 'photo.xmp'));
  const response = await patch(corpus[0]);
  expect(response.status).toBe(200);
  const output = await readFile(join(directory, 'photo.xmp'), 'utf8');
  const read = await callNative('workflowReadXmp', [output]);
  expect(read.ok).toBe(true);
  if (!read.ok) throw Error(read.error);
  expect(JSON.parse(read.value)).toEqual(corpus[0]);
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});
