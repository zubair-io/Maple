import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-workflow-cancel-api-')));
  process.env.MAPLE_ROOTS = directory;
  setLibraryRootsForTests(new Map([['workflow-cancel-fixture', directory]]));
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

const patch = (body: unknown, signal: AbortSignal) =>
  app.handle(
    new Request(
      'http://localhost/api/xmp/workflow?path=' + encodeURIComponent(join(directory, 'photo.dng')),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
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

const variantRequest = (route: string, body: unknown, signal?: AbortSignal) =>
  app.handle(
    new Request(`http://localhost/api/xmp/${route}`, {
      method: route.startsWith('variants?') ? 'POST' : 'PUT',
      headers: {
        'Content-Type': route.startsWith('variants?') ? 'application/json' : 'application/xml',
      },
      body: route.startsWith('variants?') ? JSON.stringify(body) : String(body),
      signal,
    }),
  );

const variantQuery = () => 'path=' + encodeURIComponent(join(directory, 'photo.dng'));

test('cancelling a workflow PATCH read releases the sidecar barrier', async () => {
  const destination = join(directory, 'photo.xmp');
  const realReadFile = fs.readFile.bind(fs);
  const { promise: readStarted, resolve: markReadStarted } = Promise.withResolvers<void>();
  const { promise: releaseRead, resolve: releaseStalledRead } = Promise.withResolvers<void>();
  let stalled = false;
  const readSpy = spyOn(fs, 'readFile').mockImplementation((async (
    ...args: Parameters<typeof fs.readFile>
  ) => {
    if (!stalled && args[0] === destination) {
      stalled = true;
      markReadStarted();
      await releaseRead;
    }
    return realReadFile(...args);
  }) as never);
  const controller = new AbortController();

  try {
    const cancelledPatch = patch(corpus[0], controller.signal);
    await readStarted;
    controller.abort();
    await cancelledPatch.catch(() => undefined);

    expect((await post(xml)).status).toBe(200);
  } finally {
    releaseStalledRead();
    readSpy.mockRestore();
  }
});

test('cancelling a selected-variant read releases its write barrier', async () => {
  const branch = corpus[1];
  expect((await variantRequest('variants?' + variantQuery(), branch)).status).toBe(201);
  const selected = 'variant?' + variantQuery() + '&variantId=' + branch.variantId;
  const destination = join(directory, `photo.v${branch.variantId}.xmp`);
  const realReadFile = fs.readFile.bind(fs);
  const { promise: readStarted, resolve: markReadStarted } = Promise.withResolvers<void>();
  const { promise: releaseRead, resolve: releaseStalledRead } = Promise.withResolvers<void>();
  let stalled = false;
  const readSpy = spyOn(fs, 'readFile').mockImplementation((async (
    ...args: Parameters<typeof fs.readFile>
  ) => {
    if (!stalled && args[0] === destination) {
      stalled = true;
      markReadStarted();
      await releaseRead;
    }
    return realReadFile(...args);
  }) as never);
  const controller = new AbortController();

  try {
    const cancelledWrite = variantRequest(selected, xml, controller.signal);
    await readStarted;
    controller.abort();
    await cancelledWrite.catch(() => undefined);

    const edited = xml.replace(
      'crs:ProcessVersion="15.4"',
      'crs:ProcessVersion="15.4" crs:Exposure2012="1.25"',
    );
    expect((await variantRequest(selected, edited)).status).toBe(200);
  } finally {
    releaseStalledRead();
    readSpy.mockRestore();
  }
});
