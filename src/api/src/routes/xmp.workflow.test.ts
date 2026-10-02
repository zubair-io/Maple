import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
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

const variantRequest = (route: string, method: 'GET' | 'POST' | 'PUT', body?: unknown) => {
  const url = `http://localhost/api/xmp/${route}`;
  const request =
    method === 'GET'
      ? new Request(url)
      : new Request(url, {
          method: method === 'POST' ? 'POST' : 'PUT',
          headers: { 'Content-Type': method === 'POST' ? 'application/json' : 'application/xml' },
          body: method === 'POST' ? JSON.stringify(body) : String(body),
        });
  return app.handle(request);
};
const variantQuery = () => 'path=' + encodeURIComponent(join(directory, 'photo.dng'));

test('wired API creates portable siblings, reopens and saves one identity without changing others', async () => {
  const first = corpus[1];
  const route = 'variants?' + variantQuery();
  const results = await Promise.all([
    variantRequest(route, 'POST', first),
    variantRequest(route, 'POST', first),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  const selected = 'variant?' + variantQuery() + '&variantId=' + first.variantId;
  const edited = xml.replace(
    'crs:ProcessVersion="15.4"',
    'crs:ProcessVersion="15.4" crs:Exposure2012="1.25"',
  );
  const written = await variantRequest(selected, 'PUT', edited);
  expect(written.status).toBe(200);
  const output = await written.text();
  expect(output).toContain('crs:Exposure2012="1.25"');
  const record = await callNative('workflowReadXmp', [output]);
  expect(record.ok).toBe(true);
  if (!record.ok) throw Error(record.error);
  expect(JSON.parse(record.value)).toEqual(first);
  const second = {
    ...first,
    variantId: crypto.randomUUID(),
    variantName: 'Alternate',
    snapshots: [],
    history: [],
  };
  expect(
    (await variantRequest(route + '&sourceVariantId=' + first.variantId, 'POST', second)).status,
  ).toBe(201);
  const reopened = await variantRequest(
    'variant?' + variantQuery() + '&variantId=' + second.variantId,
    'GET',
  );
  expect(reopened.status).toBe(200);
  expect(await reopened.text()).toContain('crs:Exposure2012="1.25"');
  const list = await (await variantRequest(route, 'GET')).json();
  expect(list.map((item: { variantId: string }) => item.variantId).sort()).toEqual(
    ['primary', first.variantId, second.variantId].sort(),
  );
  expect(await readFile(join(directory, 'photo.xmp'), 'utf8')).toBe(xml);
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});

test('missing, future and mismatched selected variants reject without fallback or publication', async () => {
  const route = 'variants?' + variantQuery();
  const missing = 'variant?' + variantQuery() + '&variantId=' + crypto.randomUUID();
  expect((await variantRequest(missing, 'GET')).status).toBe(404);
  expect((await variantRequest(missing, 'PUT', xml)).status).toBe(404);
  const first = corpus[1];
  expect((await variantRequest(route, 'POST', first)).status).toBe(201);
  const filename = join(directory, `photo.v${first.variantId}.xmp`);
  const saved = await readFile(filename, 'utf8');
  const future = saved.replace('<papp:SchemaVersion>1', '<papp:SchemaVersion>2');
  await writeFile(filename, future);
  const selected = 'variant?' + variantQuery() + '&variantId=' + first.variantId;
  expect((await variantRequest(selected, 'PUT', xml)).status).toBe(422);
  expect((await variantRequest(route, 'GET')).status).toBe(422);
  expect(await readFile(filename, 'utf8')).toBe(future);
  const mismatch = saved.replace(first.variantId, crypto.randomUUID());
  await writeFile(filename, mismatch);
  expect((await variantRequest(selected, 'GET')).status).toBe(422);
  expect(await readFile(filename, 'utf8')).toBe(mismatch);
  expect(await readFile(join(directory, 'photo.xmp'), 'utf8')).toBe(xml);
});

test('variant API requires committed source and authorized paths and rejects primary creation', async () => {
  const route = 'variants?' + variantQuery();
  expect((await variantRequest(route, 'POST', corpus[0])).status).toBe(409);
  await unlink(join(directory, 'photo.xmp'));
  expect((await variantRequest(route, 'POST', corpus[1])).status).toBe(409);
  expect(
    (await variantRequest(route, 'POST', { ...corpus[1], variantId: '../primary' })).status,
  ).toBe(422);
  expect((await variantRequest('variants?path=/outside/photo.dng', 'GET')).status).toBe(403);
  expect(
    (await variantRequest('variant?' + variantQuery() + '&variantId=../primary', 'PUT', xml))
      .status,
  ).toBe(422);
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});

for (const [route, method, body] of [
  ['variants', 'GET', undefined],
  ['variant', 'GET', undefined],
  ['variants', 'POST', corpus[1]],
  ['variant', 'PUT', xml],
] as const) {
  test(`${method} ${route} rejects malformed, outside-root and symlink-escape paths`, async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'maple-workflow-outside-')));
    try {
      const original = join(outside, 'photo.dng');
      const primary = join(outside, 'photo.xmp');
      const sibling = join(outside, `photo.v${corpus[1].variantId}.xmp`);
      await writeFile(original, new Uint8Array([44, 55, 66]));
      await writeFile(primary, xml);
      await writeFile(sibling, xml);
      await symlink(outside, join(directory, 'escape'), 'dir');
      const cases = [
        { path: original, status: 403 },
        { path: join(directory, 'escape', 'photo.dng'), status: 403 },
        { path: '../photo.dng', status: 400 },
        { path: '/photo%00.dng', status: 400 },
        { path: '/photo%FF.dng', status: 400 },
      ];
      for (const denied of cases) {
        const response = await variantRequest(
          route + '?path=' + encodeURIComponent(denied.path) + '&variantId=' + corpus[1].variantId,
          method,
          body,
        );
        expect(response.status).toBe(denied.status);
        expect((await response.json()).error).toBeString();
      }
      expect(await readFile(original)).toEqual(Buffer.from([44, 55, 66]));
      expect(await readFile(primary, 'utf8')).toBe(xml);
      expect(await readFile(sibling, 'utf8')).toBe(xml);
      expect(await readFile(join(directory, 'photo.xmp'), 'utf8')).toBe(xml);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
}
